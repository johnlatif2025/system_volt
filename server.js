import express from "express";
import bodyParser from "body-parser";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import admin from "firebase-admin";
import dotenv from "dotenv";
import fetch from "node-fetch";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// Firebase
if(!process.env.FIREBASE_CONFIG){ console.error("FIREBASE_CONFIG not found"); process.exit(1); }
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

app.use(bodyParser.json());
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

// Multer
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
if(!fs.existsSync(path.join(__dirname,"uploads"))) fs.mkdirSync(path.join(__dirname,"uploads"));
const storage = multer.diskStorage({
  destination:(req,file,cb)=>cb(null,"uploads/"),
  filename:(req,file,cb)=>cb(null,Date.now()+"-"+file.originalname)
});
const upload = multer({ storage });

// Telegram إشعار
async function sendTelegramMessage(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = process.env.TELEGRAM_CHAT_ID?.split(",");

  if (!botToken || !chatIds || chatIds.length === 0) {
    console.error("❌ TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not found in .env");
    return;
  }

  try {
    for (const chatId of chatIds) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId.trim(), text: message }),
      });
    }
  } catch (err) {
    console.error("❌ Error sending Telegram message:", err.message);
  }
}

// Auth middleware
function authenticateToken(req,res,next){
  const token = req.headers["authorization"]?.split(" ")[1];
  if(!token) return res.sendStatus(401);
  jwt.verify(token,process.env.JWT_SECRET,(err,user)=>{
    if(err) return res.sendStatus(403);
    req.user=user;
    next();
  });
}

// تسجيل مستخدم
app.post("/api/register-user",async(req,res)=>{
  const { username,password } = req.body;
  if(!username||!password) return res.status(400).json({error:"البيانات ناقصة"});
  const userRef = db.collection("users").doc(username);
  if((await userRef.get()).exists) return res.status(400).json({error:"المستخدم موجود"});
  const hashed = await bcrypt.hash(password,10);
  await userRef.set({ username, password:hashed, role:"user" });
  res.json({message:"تم إنشاء حساب مستخدم"});
});

// تسجيل دخول مستخدم
app.post("/api/login-user",async(req,res)=>{
  const { username,password } = req.body;
  const snapshot = await db.collection("users").where("username","==",username).get();
  if(snapshot.empty) return res.status(400).json({error:"المستخدم غير موجود"});
  const userDoc = snapshot.docs[0], user=userDoc.data();
  if(!await bcrypt.compare(password,user.password)) return res.status(400).json({error:"كلمة المرور خاطئة"});
  const token = jwt.sign({ username:user.username, role:user.role, id:userDoc.id }, process.env.JWT_SECRET,{ expiresIn:"3d" });
  res.json({token,role:user.role});
});

// تسجيل دخول أدمن
app.post("/api/login-admin",async(req,res)=>{
  const { username,password }=req.body;
  if(username!==process.env.ADMIN_USERNAME || password!==process.env.ADMIN_PASSWORD) return res.status(400).json({error:"بيانات الأدمن خاطئة"});
  const token=jwt.sign({username,role:"admin"},process.env.JWT_SECRET,{expiresIn:"30d"});
  res.json({token,role:"admin"});
});

// إضافة طلب
app.post("/api/orders", authenticateToken, upload.single("image"), async(req,res)=>{
  if(!req.body.fullName || !req.body.phone1 || !req.body.address){
    return res.status(400).json({error:"الاسم، الهاتف الأول، والعنوان مطلوبين"});
  }
  try{
    const order = { ...req.body, imageUrl:req.file?`${process.env.SERVER_URL||""}/uploads/${req.file.filename}`:"", userId:req.user.id, status:"قيد المراجعة", createdAt:new Date() };
    await db.collection("orders").add(order);

    const message = `
📦 طلب جديد
👤 الاسم: ${req.body.fullName}
📞 الهاتف1: ${req.body.phone1}
📞 الهاتف2: ${req.body.phone2||"-"}
🏠 العنوان: ${req.body.address}
📦 عدد القطع: ${req.body.pieces||"-"}
📐 المقاس: ${req.body.size||"-"}
🎨 الألوان: ${req.body.colors||"-"}
💰 السعر بدون شحن: ${req.body.priceNoShip||"-"}
💰 مصاريف الشحن: ${req.body.shipping||"-"}
💰 السعر شامل العمولة: ${req.body.priceTotal||"-"}
💸 العمولة: ${req.body.commission||"-"}
💬 ملاحظة: ${req.body.note||"-"}
📌 الحالة: ${order.status}
`;
    await sendTelegramMessage(message, order.imageUrl || null);
    res.json({message:"تم إضافة الطلب",order});
  } catch(e){ console.error(e); res.status(500).json({error:"فشل إضافة الطلب"}); }
});

// جلب الطلبات
app.get("/api/orders", authenticateToken, async(req,res)=>{
  let query=db.collection("orders");
  if(req.user.role!=="admin") query=query.where("userId","==",req.user.id);
  const orders=(await query.get()).docs.map(doc=>({id:doc.id,...doc.data()}));
  res.json(orders);
});

// تحديث الحالة (أدمن فقط)
app.patch("/api/orders/:id", authenticateToken, async(req,res)=>{
  if(req.user.role!=="admin") return res.status(403).json({error:"غير مصرح"});
  const {id}=req.params, {status}=req.body;
  await db.collection("orders").doc(id).update({status});
  res.json({message:"تم تحديث الحالة"});
});

app.listen(PORT,()=>console.log(`🚀 Server running on port ${PORT}`));