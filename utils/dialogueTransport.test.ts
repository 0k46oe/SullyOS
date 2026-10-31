import { afterEach, expect, it, vi } from 'vitest';
import { createDialogueFetch, anthropicRequestOptions } from './dialogueTransport';
import { toAnthropicRequest } from './anthropicApi';
import { normalizeApiConfig } from './apiConfigNormalize';
import { configFromPreset } from './apiPresetSwitch';
import { pickDialogueApi, resolveDialogueApi } from './characterApi';
const api = { baseUrl:'https://native.test/prefix', apiKey:'fake-only', model:'custom-model', apiType:'anthropic' as const };
const body = { model:api.model, temperature:0.37, messages:[{role:'system',content:'stable prefix'},{role:'user',content:'hello'},{role:'system',content:'volatile clock'}], tools:[{type:'function',function:{name:'lookup',parameters:{type:'object'}}}] };
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});
it('uses upstream native conversion with cache controls and all cache points sharing the selected lifetime', () => {
  const input = {...body, __sullyAnthropicOptions:anthropicRequestOptions({...api,anthropicPromptCacheTtl:'1h',anthropicCustomTemperature:true})};
  const before = JSON.stringify(input), request = toAnthropicRequest(input);
  expect(request.temperature).toBe(0.37);
  expect(JSON.stringify(request)).not.toContain('__sully');
  expect(request.tools[0].cache_control).toEqual({type:'ephemeral',ttl:'1h'});
  expect(request.system.at(-1).cache_control).toEqual({type:'ephemeral',ttl:'1h'});
  expect(request.messages[0].content[0].cache_control).toEqual({type:'ephemeral',ttl:'1h'});
  expect(request.messages.at(-1).content.at(-1).text).toContain('volatile clock');
  expect(JSON.stringify(input)).toBe(before);
});
it('turns all native cache marks off and defaults to model sampling', () => {
  const request = toAnthropicRequest({...body,__sullyAnthropicOptions:anthropicRequestOptions({...api,anthropicPromptCache:false})});
  expect(JSON.stringify(request)).not.toContain('cache_control');
  expect(request).not.toHaveProperty('temperature');
});
it('migrates legacy protocol, preserves native settings and resets lifetime when switching endpoints', () => {
  const legacy = {...api,apiType:undefined,protocol:'anthropic' as const,anthropicPromptCache:false,anthropicPromptCacheTtl:'1h' as const,anthropicCustomTemperature:true};
  expect(normalizeApiConfig(legacy)).toMatchObject({apiType:'anthropic',baseUrl:'https://native.test/prefix/messages'});
  expect(pickDialogueApi(legacy)).toMatchObject({anthropicPromptCache:false,anthropicPromptCacheTtl:'1h',anthropicCustomTemperature:true});
  expect(configFromPreset({id:'p',name:'test',config:legacy})).toMatchObject({apiType:'anthropic',anthropicPromptCacheTtl:'1h'});
  expect(resolveDialogueApi(legacy,{dialogueApi:api})).toMatchObject({anthropicPromptCache:true,anthropicPromptCacheTtl:'5m',anthropicCustomTemperature:false});
});
it('sends one native request with the upstream URL/auth converter and keeps selected temperature zero', async () => {
  const network = vi.fn(async () => new Response(JSON.stringify({type:'message',model:api.model,content:[{type:'text',text:'reply'}],usage:{input_tokens:7,output_tokens:2}})));
  vi.stubGlobal('fetch',network);
  const result = await createDialogueFetch({...api,temperature:0,anthropicCustomTemperature:true})('ignored',{method:'POST',body:JSON.stringify({...body,temperature:0})},0);
  expect(network).toHaveBeenCalledOnce();
  const [url,init] = network.mock.calls[0] as any;
  expect(url).toBe('https://native.test/prefix/messages');
  expect(new Headers(init.headers).get('x-api-key')).toBe('fake-only');
  expect(JSON.parse(init.body).temperature).toBe(0);
  expect(result.choices[0].message.content).toBe('reply');
});
it('keeps the OAI cache opt-out and never sends Anthropic control fields to OAI', async () => {
  const network = vi.fn(async () => new Response(JSON.stringify({choices:[{message:{content:'ok'}}]})));
  vi.stubGlobal('fetch',network);
  await createDialogueFetch({...api,baseUrl:'https://oai.test/v1',apiType:'openai',openaiPromptCache:false})('https://oai.test/v1/chat/completions',{method:'POST',body:JSON.stringify(body)},0);
  const sent = JSON.parse((network.mock.calls[0] as any)[1].body);
  expect(sent).not.toHaveProperty('prompt_cache_key');
  expect(JSON.stringify(sent)).not.toContain('cache_control');
  expect(JSON.stringify(sent)).not.toContain('__sully');
});
