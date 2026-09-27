import assert from "node:assert/strict";
import test from "node:test";
import { imageVariantUrl, packImageAddresses, unpackImageAddresses } from "@imageshow/shared/browser";

test("[Shared/图片地址] 单根省略索引，混合后端保持顺序且每页独立绑定", () => {
  const image = (id:string,base_url:string)=>({id,base_url,title:id,width:600,height:400});
  const first=image("00000000-0000-7000-8000-000000000011","/images");
  const second=image("00000000-0000-7000-8000-000000000022","https://cdn.example/root%20path");
  const one={ok:true,items:[first, {...first,id:"00000000-0000-7000-8000-000000000033"}]};
  const packed=packImageAddresses(one);
  assert.deepEqual(packed.base_urls,["/images"]);
  assert.deepEqual(packed.items,one.items.map(({base_url:_,...item})=>item));
  assert.deepEqual(unpackImageAddresses(packed),one);
  const mixed={ok:true,items:[second,first,second]};
  const wire=packImageAddresses(mixed);
  assert.deepEqual(wire.base_urls,[second.base_url,first.base_url]);
  assert.deepEqual(wire.items.map(item=>item.base_index),[1,2,1]);
  assert.deepEqual(unpackImageAddresses(wire),mixed);
  const next=packImageAddresses({items:[first,second]});
  assert.deepEqual(unpackImageAddresses(next),{items:[first,second]});
  assert.equal(imageVariantUrl(second,"medium"),"https://cdn.example/root%20path/medium/22/00000000-0000-7000-8000-000000000022.webp");
  assert.equal(first.base_url,"/images");
  for(const index of [0,-1,3,1.5,undefined])assert.throws(()=>unpackImageAddresses({base_urls:wire.base_urls,items:[{...wire.items[0],base_index:index}]}));
});

test("[Shared/图片地址] 正式结果和重复候选嵌套共享地址表，元数据不参与地址绑定",()=>{
  const item={id:"00000000-0000-7000-8000-000000000044",base_url:"/images",title:"fixture",width:600,height:400};
  const body={session:{completed_item:item,duplicates:[item],metadata:{title:"unchanged",base_url:"metadata-value"}},results:[{item}],details:{duplicates:[item]}};
  const wire=packImageAddresses(body);
  assert.deepEqual(wire.base_urls,["/images"]);
  assert.deepEqual(unpackImageAddresses(wire),body);
  assert.deepEqual(packImageAddresses({items:[],next_cursor:null}),{items:[],next_cursor:null});
});
