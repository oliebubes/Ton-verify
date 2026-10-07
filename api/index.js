export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const MYWALLET = process.env.MYWALLET || "UQCDRPXIZ16s_I_o1j_ROAWz81zhO1RRmEbgCkqTsI3KbkN8";
  const BOTTOKEN = process.env.BOTTOKEN;
  const ADMINID = process.env.ADMINID;
  const TONAPIKEY = process.env.TONAPIKEY;

  const url = new URL(req.url, `https://${req.headers.host}`);
  const p = url.searchParams;
  const tg = async (msg) => {
    try { await fetch(`https://api.telegram.org/bot${BOTTOKEN}/sendMessage?chat_id=${ADMINID}&text=${encodeURIComponent(msg)}&parse_mode=HTML`); } catch {}
  };

  // JOIN - only telegram info
  if (url.pathname.includes("join")) {
    const username = p.get("username") || "No username";
    const tgid = p.get("tgid") || "";
    const invitedBy = p.get("invitedBy") || "Direct";
    const total = p.get("total") || "?";
    await tg(`👤 JOIN\nName: @${username}\nTG ID: ${tgid}\nInvited by: ${invitedBy}\nTotal: ${total}\nWallet: Not connected yet`);
    return res.json({ok:true});
  }

  // VERIFY PAYMENT - THIS IS THE MAIN SECURITY
  if (url.pathname.includes("verify")) {
    const tx = p.get("tx");
    const userWallet = p.get("address") || "unknown";
    const username = p.get("username") || "";
    const sent = parseFloat(p.get("amount") || "0");
    const need = parseFloat(p.get("required") || "0");
    const asset = p.get("asset") || "TON";

    if (!tx) return res.json({ok:false, msg:"no tx hash"});

    // 1. Check amount first - if less than required, reject immediately
    if (need > 0 && sent < need - 0.0001) {
      await tg(`⚠️ INVALID REQUEST\nUser @${username} \nWallet: <code>${userWallet}</code>\nNeeded: ${need} ${asset}\nSent: ${sent} ${asset}\nReason: Underpaid`);
      return res.json({ok:false, reason:"invalid_amount", msg:`Invalid request: You sent ${sent} but required is ${need}. Please complete payment.`});
    }

    // 2. Check TonAPI - did money reach YOUR wallet?
    try {
      const r = await fetch(`https://tonapi.io/v2/blockchain/transactions/${tx}`, {
        headers: { "Authorization": `Bearer ${TONAPIKEY}` }
      });
      const data = await r.json();
      const str = JSON.stringify(data);

      const toYou = str.includes(MYWALLET) || str.includes(MYWALLET.substring(2,12));

      if (!toYou) {
        await tg(`🚨 FAKE TX - NOT TO YOUR WALLET\nUser @${username}\nWallet: <code>${userWallet}</code>\nTx: ${tx}\nAmount: ${sent}\nIt did NOT reach ${MYWALLET.slice(0,8)}`);
        return res.json({ok:false, reason:"not_to_mywallet", msg:"Payment not detected to main wallet. Invalid."});
      }

      // Success
      await tg(`✅ VERIFIED PAYMENT\nUser: @${username}\nWallet: <code>${userWallet}</code>\nAmount: ${sent}/${need} ${asset}\nTx: <code>${tx}</code>\nMoney reached YOUR wallet!`);
      return res.json({ok:true, verified:true});

    } catch (e) {
      return res.json({ok:false, error:e.message});
    }
  }

  // WIN / LOSE
  if (url.pathname.includes("win")) {
    await tg(`🏆 WIN @${p.get("username")} - ${p.get("profit")} ${p.get("asset")} Wallet: <code>${p.get("address")}</code> - You need to pay`);
    return res.json({ok:true});
  }
  if (url.pathname.includes("lose")) {
    await tg(`💸 LOSE @${p.get("username")} - Lost ${p.get("amount")} ${p.get("asset")} Wallet: <code>${p.get("address")}</code> - YOU KEEP`);
    return res.json({ok:true});
  }

  // WITHDRAW REQUEST - when they reach 50k
  if (url.pathname.includes("withdraw")) {
    const username = p.get("username");
    const wallet = p.get("address");
    const amount = p.get("amount");
    await tg(`💰 WITHDRAW REQUEST 50k+\nUser: @${username}\nWallet to credit: <code>${wallet}</code>\nAmount: ${amount}\nPlease verify and credit manually`);
    return res.json({ok:true});
  }

  return res.json({ok:true, msg:"API running for " + MYWALLET});
}
