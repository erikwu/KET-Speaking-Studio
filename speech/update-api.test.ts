import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createUpdateApi } from "./update-api.ts";

test("update API blocks cross-origin calls, active exams and concurrent mutations", async () => {
  let api: ReturnType<typeof createUpdateApi>, busy = false;
  const calls: string[] = [];
  const server = createServer(async (req, res) => { await api.handle(req, res, req.url!); });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();assert.ok(address&&typeof address==="object");
  const origin=`http://127.0.0.1:${address.port}`;
  api=createUpdateApi({port:address.port,busy:()=>busy,managed:true,rpc:async action=>{calls.push(action);return {phase:"idle"};}});
  try {
    const {token}=await(await fetch(`${origin}/api/update`)).json() as any;
    const post=(route:string,body:any,extra={})=>fetch(origin+route,{method:"POST",headers:{origin,"content-type":"application/json","x-ket-update-token":token,...extra},body:JSON.stringify(body)});
    assert.equal((await post('/api/update/apply',{target:'a'.repeat(40)},{origin:'https://example.com'})).status,403);
    assert.equal((await post('/api/update/apply',{target:'a'.repeat(40)},{'x-ket-update-token':'wrong'})).status,403);
    await post('/api/update/lease',{clientId:'one',active:true});
    assert.equal((await post('/api/update/apply',{target:'a'.repeat(40)})).status,409);
    await post('/api/update/lease',{clientId:'one',active:false});busy=true;
    assert.equal((await post('/api/update/apply',{target:'a'.repeat(40)})).status,409);
    busy=false; assert.equal((await post('/api/update/apply',{target:'a'.repeat(40)})).status,202);
    assert.equal((await post('/api/update/apply',{target:'a'.repeat(40)})).status,409);
    assert.equal(api.maintenance(),true);
    assert.equal((await post('/api/update/lease',{clientId:'two',active:true})).status,409);
    assert.deepEqual(calls,['status','apply']);
  } finally {server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
