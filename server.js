import express from "express";
import bodyParser from "body-parser";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Firebase init من متغير البيئة FIREBASE_CONFIG
if (!process.env.FIREBASE_CONFIG) {
  console.error("❌ FIREBASE_CONFIG not found in environment variables");
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

app.use(bodyParser.json());
app.use(express.static("public"));

// Middleware للتحقق من التوكن
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// ✅ إنشاء حساب
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "الاسم والباسورد مطلوبين" });

  const usersRef = db.collection("users");
  const snapshot = await usersRef.where("username", "==", username).get();
  if (!snapshot.empty) {
    return res.status(400).json({ error: "المستخدم موجود بالفعل" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  await usersRef.add({ username, password: hashedPassword, role: "user" });

  res.json({ message: "تم إنشاء الحساب بنجاح" });
});

// ✅ تسجيل دخول
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const usersRef = db.collection("users");
  const snapshot = await usersRef.where("username", "==", username).get();

  if (snapshot.empty) {
    return res.status(400).json({ error: "المستخدم غير موجود" });
  }

  const userDoc = snapshot.docs[0];
  const user = userDoc.data();
  const validPassword = await bcrypt.compare(password, user.password);

  if (!validPassword) {
    return res.status(400).json({ error: "كلمة المرور غير صحيحة" });
  }

  const token = jwt.sign(
    { username: user.username, role: user.role, id: userDoc.id },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  res.json({ token, role: user.role });
});

// ✅ إضافة طلب (للعملاء)
app.post("/api/orders", authenticateToken, async (req, res) => {
  const order = {
    ...req.body,
    userId: req.user.id,
    status: "قيد المراجعة",
    createdAt: new Date(),
  };
  await db.collection("orders").add(order);
  res.json({ message: "تم إضافة الطلب", order });
});

// ✅ جلب طلبات العميل
app.get("/api/orders", authenticateToken, async (req, res) => {
  let query = db.collection("orders");
  if (req.user.role !== "admin") {
    query = query.where("userId", "==", req.user.id);
  }
  const snapshot = await query.get();
  const orders = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  res.json(orders);
});

// ✅ تحديث حالة الطلب (للمدير فقط)
app.patch("/api/orders/:id", authenticateToken, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "غير مصرح لك" });
  }
  const { id } = req.params;
  const { status } = req.body;
  await db.collection("orders").doc(id).update({ status });
  res.json({ message: "تم تحديث الحالة" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
