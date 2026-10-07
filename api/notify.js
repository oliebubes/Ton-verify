export default async function handler(req,res){
 res.setHeader("Access-Control-Allow-Origin","*");
 const BOTTOKEN=process.env.BOTTOKEN;
 const ADMINID=process.env.ADMINID;
 const msg=req.query.msg||"test";
 await fetch(`https://api.telegram.org/bot${BOTTOKEN}/sendMessage?chat_id=${ADMINID}&text=${encodeURIComponent(msg)}`);
 res.json({ok:true});
   }
