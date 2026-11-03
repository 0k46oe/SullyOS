import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const out=process.env.COLLABORATION_QA_OUTPUT || 'output/collaboration-drafts';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const requests=[],visionRequests=[],errors=[];
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/qa-chat/v1/chat/completions',async route=>{
 requests.push(route.request().postDataJSON());
 await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'已收到，我们继续一起整理。[[SEND_EMOJI: 小猫贴贴]]'}}]})});
});
await page.route('**/qa-vision/v1/chat/completions',async route=>{
 visionRequests.push(route.request().postDataJSON());
 await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'奶油色的小猫抬起爪子，下面写着贴贴。'}}]})});
});
const button=name=>page.getByRole('button',{name,exact:true});
const draft=page.locator('.collab-composer-field textarea');
const wait=ms=>page.waitForTimeout(ms);
const waitReply=async count=>{
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){
  if(requests.length>=count&&await button('停止生成').count()===0&&await page.locator('.collab-message-row-assistant').count()>=count)return;
  await wait(100);
 }
 throw new Error(`Timed out waiting for completed reply ${count}`);
};
try {
 await page.goto('http://127.0.0.1:5183/test/fixtures/collaboration-drafts.html',{timeout:120000});
 await page.getByRole('button',{name:/中度协同/}).click({timeout:60000});
 await draft.fill('这里有错自');await button('发送').click();
 assert.equal(requests.length,0);
 const bubble=page.locator('.collab-message-row-user').first();
 await bubble.click({button:'right'});
 await wait(2200);assert.equal(requests.length,0);
 await button('编辑内容').click();
 const editor=page.getByRole('dialog',{name:'编辑自己的消息'});
 await editor.locator('textarea').fill('这里的错字已经修正');
 await wait(2200);assert.equal(requests.length,0);
 await page.screenshot({path:out+'/collaboration-edit-before-ai.png'});
 await editor.getByRole('button',{name:'保存修改',exact:true}).click();
 await button('协同设置').click();await wait(2200);assert.equal(requests.length,0);
 await button('保存').click();await wait(1100);assert.equal(requests.length,0);
 await waitReply(1);assert.equal(requests.length,1);
 assert(JSON.stringify(requests[0]).includes('这里的错字已经修正'));assert(!JSON.stringify(requests[0]).includes('这里有错自'));
 await button('表情包').click();await button('发送表情包：小猫贴贴').click();
 await wait(2200);assert.equal(requests.length,1);
 assert.equal(await page.locator('.collab-message-row-user img[alt="小猫贴贴"]').count(),1);
 await page.screenshot({path:out+'/collaboration-user-sticker.png'});
 await button('关闭表情包').click();
 await waitReply(2);
 assert.equal(requests.length,2);assert.equal(visionRequests.length,0);
 assert(!JSON.stringify(requests[1]).includes('image_url'));assert(!JSON.stringify(requests[1]).includes('data:image'));
 await page.evaluate(()=>window.collaborationQA.setVision(true));
 await draft.fill('继续看刚才的表情');await button('发送').click();
 await waitReply(3);
 assert.equal(visionRequests.length,1);
 const described=requests[2].messages.filter(message=>message.content.includes('发送了表情包'));
 assert(described.some(message=>message.role==='assistant'&&message.content.includes('奶油色的小猫')));
 assert(described.some(message=>message.role==='user'&&message.content.includes('奶油色的小猫')));
 assert(!JSON.stringify(requests[2]).includes('image_url'));assert(!JSON.stringify(requests[2]).includes('data:image'));
 await page.evaluate(()=>window.collaborationQA.setVision(false));
 await draft.fill('关闭识图，再继续');await button('发送').click();
 await waitReply(4);
 assert.equal(visionRequests.length,1);assert(!JSON.stringify(requests[3]).includes('奶油色的小猫'));
 assert(!JSON.stringify(requests[3]).includes('data:image'));assert(!JSON.stringify(requests[3]).includes('image_url'));
 assert.deepEqual(errors,[]);
 console.log('PASS: actual UI edits before AI, blocks all open panels, delays two seconds, sends user stickers, gates both speakers on vision and hides cached descriptions when disabled.');
}catch(error){await page.screenshot({path:out+'/failure.png'});console.error(errors,(await page.locator('body').innerText()).slice(-1800));throw error;}
finally{await browser.close();}
