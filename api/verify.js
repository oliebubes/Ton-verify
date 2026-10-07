export default async function handler(req,res){
 res.setHeader("Access-Control-Allow-Origin","*");
 const TONAPI_KEY = process.env.TONAPIKEY;
 const tx = req.query.tx;
 const expected = parseInt(req.query.amount||"0");
 if(!tx) return res.status(400).json({ok:false,error:"missing tx"});
 const r=await fetch("https://tonapi.io/v2/blockchain/transactions/"+tx,{headers:{"Authorization":"Bearer "+TONAPI_KEY}});
 const j=await r.json();
 if(!j.transaction_id) return res.json({ok:false,error:"tx not found"});
 let found=0,toYou=false;
 for(const m of j.out_msgs||[]){
   if(m.decoded_body?.destination==="UQCDRPXIZ16s_I_o1j_ROAWz81zhO1RRmEbgCkqTsI3KbkN8"){toYou=true;found=parseInt(m.decoded_body.jetton_amount)/1000000;}
 }
 if(!toYou) return res.json({ok:false,error:"Not to you"});
 if(found<expected) return res.json({ok:false,error:`Sent ${found} need ${expected}`});
 return res.json({ok:true,amount:found});
}
