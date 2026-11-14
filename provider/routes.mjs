export const initialState = { generation: 1, mode: 'normal', clock: 1000 };
export async function stop(state) {  }
export async function routes(context) {
 const { request, url, body, payload, state, json, text, binary } = context;

 if (url.pathname === '/time') return json({ lower:state.clock-2,upper:state.clock+2,epoch:'show-clock',validFor:10 });
 if (url.pathname === '/schedule') return json({ revision:state.generation,clock:'/time',publications:[
   {id:'camera',release:state.generation===1?1010:1030,version:'spec-'+state.generation,status:'scheduled'},
   {id:'sensor',release:1005,version:'sensor-1',status:state.mode==='cancelled'?'cancelled':'scheduled'}] });
 if (url.pathname.startsWith('/publication/')) {
   const id=url.pathname.split('/').at(-1);
   const release=id==='camera'?(state.generation===1?1010:1030):1005;
   if (id==='sensor' && state.mode==='cancelled') return json({error:'发布取消'},410);
   if (state.clock<release) return json({error:'尚未开放'},425);
   const version=id==='camera'?'spec-'+state.generation:'sensor-1';
   if (url.searchParams.get('version')!==version) return json({error:'排期版本已变化'},409);
   return json({id,version,releasedAt:release,details:'产品合成参数'});
 }

}
