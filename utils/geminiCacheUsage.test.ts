import {expect,it,vi,afterEach} from 'vitest';
import {parseSseToCompletion,safeFetchJson} from './safeApi';
import {extractApiTokenUsage,scanSseForLog} from './apiCallLog';
afterEach(()=>vi.unstubAllGlobals());
const usage={promptTokenCount:100,candidatesTokenCount:12,totalTokenCount:112,cachedContentTokenCount:64};
const sse=(field:string)=>[JSON.stringify({model:'gemini-test',choices:[{delta:{content:'ok'}}]}),JSON.stringify({choices:[],[field]:usage})].map(chunk=>'data: '+chunk+String.fromCharCode(10,10)).join('')+'data: [DONE]'+String.fromCharCode(10);
it.each(['usageMetadata','usage_metadata'])('keeps Gemini cache counts through %s SSE parsing and logging',field=>{
 const text=sse(field),parsed=parseSseToCompletion(text),logged=scanSseForLog(text);
 expect(parsed.choices[0].message.content).toBe('ok');expect(parsed.usage).toEqual(usage);expect(logged.usage).toEqual(usage);
 expect(extractApiTokenUsage(parsed)).toEqual({prompt:100,completion:12,total:112,cacheRead:64});
});
it('preserves Gemini cache counts through actual stream reading',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(sse('usageMetadata'),{headers:{'Content-Type':'text/event-stream'}})));
 const result=await safeFetchJson('https://cache.test/v1/chat/completions',{method:'POST',body:'{}'},0,0,undefined,{onDelta:()=>{}});
 expect(extractApiTokenUsage(result).cacheRead).toBe(64);
});
it('does not add OAI cached tokens twice to inclusive input_tokens',()=>{
 expect(extractApiTokenUsage({usage:{input_tokens:100,output_tokens:12,input_tokens_details:{cached_tokens:64}}})).toEqual({prompt:100,completion:12,total:112,cacheRead:64});
 expect(extractApiTokenUsage({usage:{input_tokens:10,output_tokens:12,cache_read_input_tokens:64,cache_creation_input_tokens:26}})).toEqual({prompt:100,completion:12,total:112,cacheRead:64,cacheCreation:26});
});
it('keeps unreported cache use distinct from an actual zero hit',()=>{
 expect(extractApiTokenUsage({usageMetadata:{promptTokenCount:100}})).not.toHaveProperty('cacheRead');
 expect(extractApiTokenUsage({usageMetadata:{...usage,cachedContentTokenCount:0}}).cacheRead).toBe(0);
});

it('waits for requested usage after finish_reason in a separate network read',async()=>{
 const enc=new TextEncoder();
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(controller){
  controller.enqueue(enc.encode('data: '+JSON.stringify({choices:[{delta:{content:'reply'},finish_reason:'stop'}]})+String.fromCharCode(10,10)));
  setTimeout(()=>{controller.enqueue(enc.encode('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:100,prompt_tokens_details:{cached_tokens:64}}})+String.fromCharCode(10,10)));controller.close();},20);
 }}),{headers:{'Content-Type':'text/event-stream'}})));
 const result=await safeFetchJson('https://cache.test/v1/chat/completions',{method:'POST',body:JSON.stringify({stream:true,stream_options:{include_usage:true}})},0,0,undefined,{});
 expect(result.choices[0].message.content).toBe('reply');expect(extractApiTokenUsage(result).cacheRead).toBe(64);
});
it('still closes a proxy that never sends requested trailing usage',async()=>{
 const cancel=vi.fn(),enc=new TextEncoder();
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(enc.encode('data: '+JSON.stringify({choices:[{delta:{content:'reply'},finish_reason:'stop'}]})+String.fromCharCode(10,10)));},cancel}),{headers:{'Content-Type':'text/event-stream'}})));
 const result=await safeFetchJson('https://cache.test/v1/chat/completions',{method:'POST',body:JSON.stringify({stream:true,stream_options:{include_usage:true}})},0,0,undefined,{});
 expect(result.choices[0].message.content).toBe('reply');expect(cancel).toHaveBeenCalledOnce();
});
