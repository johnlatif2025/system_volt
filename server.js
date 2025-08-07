const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const nodemailer = require("nodemailer");
const path = require("path");
const multer = require('multer');
const fs = require('fs');
require('dotenv').config(); // تأكد من أن هذا السطر موجود لتحميل متغيرات البيئة

const app = express();

// إعداد قاعدة البيانات
const db = new sqlite3.Database("./data.db", sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error("Error opening database:", err.message);
    process.exit(1);
  }
  console.log("Connected to SQLite database");
});

// إعدادات الميدل وير
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://7oda-store-production.up.railway.app'],
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// إعداد الجلسة
app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
}));

// إنشاء مجلد uploads إذا لم يكن موجوداً
if (!fs.existsSync('public/uploads')) {
  fs.mkdirSync('public/uploads', { recursive: true });
}

// إعداد multer لرفع الملفات
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
  // يمكنك إضافة قيود على حجم الملفات أو أنواعها هنا
});
const upload = multer({ storage });

// إعداد البريد الإلكتروني مع SMTP
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
});

// إنشاء الجداول
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    playerId TEXT,
    email TEXT,
    type TEXT,
    ucAmount TEXT,
    bundle TEXT,
    totalAmount TEXT,
    transactionId TEXT,
    screenshot TEXT,
    status TEXT DEFAULT 'لم يتم الدفع'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    message TEXT,
    status TEXT DEFAULT 'قيد الانتظار',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    contact TEXT,
    message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // جدول جديد للمنتجات (شدات وحزم)
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,   -- 'uc' أو 'bundle'
    amount INTEGER,           -- عدد الشدات (لـ UC)
    price REAL NOT NULL,
    image_url TEXT
  )`);
});

// Routes لخدمة صفحات HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get("/dashboard", (req, res) => {
  if (!req.session.admin) {
    return res.redirect('/login');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// API Routes
app.post("/api/order", upload.single('screenshot'), (req, res) => {
  const { name, playerId, email, selectedProductId, totalAmount, transactionId } = req.body;

  if (!name || !playerId || !email || !transactionId || !totalAmount || !selectedProductId) {
    return res.status(400).json({ success: false, message: "جميع الحقول مطلوبة" });
  }

  // جلب تفاصيل المنتج من قاعدة البيانات بناءً على selectedProductId
  db.get("SELECT name, category, amount FROM products WHERE id = ?", [selectedProductId], (err, product) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات عند جلب تفاصيل المنتج" });
    }
    if (!product) {
      return res.status(404).json({ success: false, message: "المنتج المحدد غير موجود" });
    }

    const type = product.category === 'uc' ? "UC" : "Bundle";
    const ucAmount = product.category === 'uc' ? product.amount : null;
    const bundle = product.category === 'bundle' ? product.name : null;
    const screenshot = req.file ? `/uploads/${req.file.filename}` : null;

    db.run(
      `INSERT INTO orders (name, playerId, email, type, ucAmount, bundle, totalAmount, transactionId, screenshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, playerId, email, type, ucAmount, bundle, totalAmount, transactionId, screenshot],
      function(err) {
        if (err) {
          console.error(err);
          return res.status(500).json({ success: false, message: "حدث خطأ أثناء الحفظ" });
        }
        res.json({ success: true, id: this.lastID });
      }
    );
  });
});

app.post("/api/inquiry", async (req, res) => {
  const { email, message } = req.body;

  if (!email || !message) {
    return res.status(400).json({ success: false, message: "البريد والرسالة مطلوبان" });
  }

  try {
    db.run(
      "INSERT INTO inquiries (email, message) VALUES (?, ?)",
      [email, message],
      async function(err) {
        if (err) return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات" });

        await transporter.sendMail({
          from: `"فريق الدعم" <${process.env.SMTP_USER}>`,
          to: process.env.SMTP_USER,
          subject: "استفسار جديد من العميل",
          html: `
            <div dir="rtl">
              <h2 style="color: #ffa726;">استفسار جديد</h2>
              <p><strong>البريد:</strong> ${email}</p>
              <p><strong>الرسالة:</strong></p>
              <p style="background: #f5f5f5; padding: 10px; border-right: 3px solid #ffa726;">${message}</p>
            </div>
          `,
        });

        res.json({ success: true });
      }
    );
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: "فشل إرسال البريد الإلكتروني" });
  }
});

app.post("/api/suggestion", async (req, res) => {
  const { name, contact, message } = req.body;

  if (!name || !contact || !message) {
    return res.status(400).json({ success: false, message: "جميع الحقول مطلوبة" });
  }

  try {
    db.run(
      "INSERT INTO suggestions (name, contact, message) VALUES (?, ?, ?)",
      [name, contact, message],
      async function(err) {
        if (err) return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات" });

        await transporter.sendMail({
          from: `"اقتراح جديد" <${process.env.SMTP_USER}>`,
          to: process.env.SMTP_USER,
          subject: "اقتراح جديد للموقع",
          html: `
            <div dir="rtl">
              <h2 style="color: #ffa726;">اقتراح جديد</h2>
              <p><strong>الاسم:</strong> ${name}</p>
              <p><strong>طريقة التواصل:</strong> ${contact}</p>
              <p><strong>الاقتراح:</strong></p>
              <p style="background: #f5f5f5; padding: 10px; border-right: 3px solid #ffa726;">${message}</p>
            </div>
          `,
        });

        res.json({ success: true });
      }
    );
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: "فشل إرسال الاقتراح" });
  }
});

// Admin Routes
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    req.session.admin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ success: false });
    }
    res.json({ success: true });
  });
});

app.get("/api/admin/orders", (req, res) => {
  if (!req.session.admin) return res.status(403).json({ success: false, message: "غير مصرح" });

  db.all("SELECT * FROM orders ORDER BY id DESC", (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات" });
    }
    res.json({ success: true, data: rows });
  });
});

app.get("/api/admin/inquiries", (req, res) => {
  if (!req.session.admin) return res.status(403).json({ success: false, message: "غير مصرح" });

  db.all("SELECT * FROM inquiries ORDER BY created_at DESC", (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات" });
    }
    res.json({ success: true, data: rows });
  });
});

app.get("/api/admin/suggestions", (req, res) => {
  if (!req.session.admin) return res.status(403).json({ success: false, message: "غير مصرح" });

  db.all("SELECT * FROM suggestions ORDER BY created_at DESC", (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات" });
    }
    res.json({ success: true, data: rows });
  });
});

app.post("/api/admin/update-status", (req, res) => {
  if (!req.session.admin) return res.status(403).json({ success: false, message: "غير مصرح" });

  const { id, status } = req.body;
  if (!id || !status) {
    return res.status(400).json({ success: false, message: "معرّف الطلب والحالة مطلوبان" });
  }

  db.run(
    "UPDATE orders SET status = ? WHERE id = ?",
    [status, id],
    function(err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "حدث خطأ أثناء التحديث" });
      }
      res.json({ success: true });
    }
  );
});

app.delete("/api/admin/delete-order", (req, res) => {
  if (!req.session.admin) return res.status(403).json({ success: false, message: "غير مصرح" });

  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, message: "معرّف الطلب مطلوب" });
  }

  db.run("DELETE FROM orders WHERE id = ?", [id], function(err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: "حدث خطأ أثناء الحذف" });
    }
    res.json({ success: true });
  });
});

app.delete("/api/admin/delete-inquiry", (req, res) => {
  if (!req.session.admin) return res.status(403).json({ success: false, message: "غير مصرح" });

  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, message: "معرّف الاستفسار مطلوب" });
  }

  db.run("DELETE FROM inquiries WHERE id = ?", [id], function(err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: "حدث خطأ أثناء الحذف" });
    }
    res.json({ success: true });
  });
});

app.delete("/api/admin/delete-suggestion", (req, res) => {
  if (!req.session.admin) return res.status(403).json({ success: false, message: "غير مصرح" });

  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, message: "معرّف الاقتراح مطلوب" });
  }

  db.run("DELETE FROM suggestions WHERE id = ?", [id], function(err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: "حدث خطأ أثناء الحذف" });
    }
    res.json({ success: true });
  });
});

app.post("/api/admin/reply-inquiry", async (req, res) => {
  if (!req.session.admin) return res.status(403).json({ success: false, message: "غير مصرح" });

  const { inquiryId, email, message, reply } = req.body;
  if (!inquiryId || !email || !message || !reply) {
    return res.status(400).json({ success: false, message: "جميع الحقول مطلوبة" });
  }

  try {
    await transporter.sendMail({
      from: `"فريق الدعم" <${process.env.SMTP_USER}>`,
      to: email,
      subject: "رد على استفسارك",
      html: `
        <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #ffa726;">شكراً لتواصلك معنا</h2>
          <p><strong>استفسارك:</strong></p>
          <p style="background: #f5f5f5; padding: 10px; border-right: 3px solid #ffa726;">${message}</p>
          <h3 style="color: #ffa726;">رد الفريق:</h3>
          <p style="background: #f5f5f5; padding: 10px; border-right: 3px solid #2196F3;">${reply}</p>
          <hr>
          <p style="text-align: center; color: #777;">مع تحيات فريق الدعم</p>
        </div>
      `
    });

    db.run("UPDATE inquiries SET status = 'تم الرد' WHERE id = ?", [inquiryId]);
    res.json({ success: true });
  } catch (error) {
    console.error("Error sending reply:", error);
    res.status(500).json({ success: false, message: "فشل إرسال الرد" });
  }
});

app.post("/api/admin/send-message", async (req, res) => {
  if (!req.session.admin) return res.status(403).json({ success: false, message: "غير مصرح" });

  const { email, subject, message } = req.body;
  if (!email || !subject || !message) {
    return res.status(400).json({ success: false, message: "جميع الحقول مطلوبة" });
  }

  try {
    await transporter.sendMail({
      from: `"فريق الدعم" <${process.env.SMTP_USER}>`,
      to: email,
      subject: subject,
      html: `
        <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #ffa726;">${subject}</h2>
          <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; border-right: 3px solid #2196F3;">
            ${message.replace(/\n/g, '<br>')}
          </div>
          <hr>
          <p style="text-align: center; color: #777;">مع تحيات فريق الدعم</p>
        </div>
      `
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ success: false, message: "فشل إرسال الرسالة" });
  }
});

// API لتغيير كلمة مرور المسؤول
app.post('/api/admin/change-password', (req, res) => {
  const { username, currentPassword, newPassword } = req.body;

  // تحقق من بيانات الدخول الحالية
  if (username !== process.env.ADMIN_USER || currentPassword !== process.env.ADMIN_PASS) {
    return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور الحالية غير صحيحة' });
  }

  // تحقق من أن كلمة المرور الجديدة ليست فارغة
  if (!newPassword || newPassword.trim() === '') {
    return res.status(400).json({ success: false, message: 'كلمة المرور الجديدة لا يمكن أن تكون فارغة' });
  }

  const envPath = path.join(__dirname, '.env');

  fs.readFile(envPath, 'utf8', (err, data) => {
    if (err) {
      console.error("Error reading .env file:", err);
      return res.status(500).json({ success: false, message: 'خطأ في قراءة ملف الإعدادات' });
    }

    // استبدال كلمة المرور القديمة بالجديدة في محتوى الملف
    // يجب أن تكون حذراً هنا لضمان استبدال السطر الصحيح فقط
    let updatedData = data.replace(`ADMIN_PASS=${currentPassword}`, `ADMIN_PASS=${newPassword}`);

    fs.writeFile(envPath, updatedData, 'utf8', (err) => {
      if (err) {
        console.error("Error writing to .env file:", err);
        return res.status(500).json({ success: false, message: 'خطأ في تحديث ملف الإعدادات' });
      }

      // تحديث متغير البيئة في الذاكرة ليعكس التغيير فوراً
      // هذا مهم لكي لا تحتاج لإعادة تشغيل الخادم فوراً لتطبيق التغيير
      process.env.ADMIN_PASS = newPassword;

      console.log("Admin password updated successfully in .env");
      res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح' });
    });
  });
});


// --- Products API Routes (UC Options & Bundles) ---
// Get all products (UC options and bundles)
app.get("/api/products", (req, res) => {
  db.all("SELECT * FROM products ORDER BY category ASC, amount ASC, price ASC", (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات" });
    }
    res.json({ success: true, data: rows });
  });
});

// Admin: Get all products (requires admin session)
app.get("/api/admin/products", (req, res) => {
  if (!req.session.admin) return res.status(403).json({ success: false, message: "غير مصرح" });

  db.all("SELECT * FROM products ORDER BY category ASC, amount ASC, price ASC", (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات" });
    }
    res.json({ success: true, data: rows });
  });
});

// Admin: Add a new product
app.post("/api/admin/products", (req, res) => {
  if (!req.session.admin) return res.status(403).json({ success: false, message: "غير مصرح" });

  const { name, category, amount, price, image_url } = req.body;
  if (!name || !category || !price || !image_url) {
    return res.status(400).json({ success: false, message: "جميع الحقول المطلوبة (الاسم، الفئة، السعر، الصورة) مطلوبة" });
  }
  if (category === 'uc' && (amount === undefined || amount === null)) { // Changed to check for undefined/null
    return res.status(400).json({ success: false, message: "عدد الشدات مطلوب لفئة UC" });
  }

  db.run(
    "INSERT INTO products (name, category, amount, price, image_url) VALUES (?, ?, ?, ?, ?)",
    [name, category, amount, price, image_url],
    function(err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "حدث خطأ أثناء الإضافة" });
      }
      res.json({ success: true, id: this.lastID });
    }
  );
});

// Admin: Update an existing product
app.put("/api/admin/products/:id", (req, res) => {
  if (!req.session.admin) return res.status(403).json({ success: false, message: "غير مصرح" });

  const { id } = req.params;
  const { name, category, amount, price, image_url } = req.body;
  if (!name || !category || !price || !image_url) {
    return res.status(400).json({ success: false, message: "جميع الحقول المطلوبة (الاسم، الفئة، السعر، الصورة) مطلوبة" });
  }
  if (category === 'uc' && (amount === undefined || amount === null)) { // Changed to check for undefined/null
    return res.status(400).json({ success: false, message: "عدد الشدات مطلوب لفئة UC" });
  }

  db.run(
    "UPDATE products SET name = ?, category = ?, amount = ?, price = ?, image_url = ? WHERE id = ?",
    [name, category, amount, price, image_url, id],
    function(err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "حدث خطأ أثناء التحديث" });
      }
      if (this.changes === 0) {
        return res.status(404).json({ success: false, message: "المنتج غير موجود" });
      }
      res.json({ success: true });
    }
  );
});

// Admin: Delete a product
app.delete("/api/admin/products/:id", (req, res) => {
  if (!req.session.admin) return res.status(403).json({ success: false, message: "غير مصرح" });

  const { id } = req.params;
  db.run("DELETE FROM products WHERE id = ?", [id], function(err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: "حدث خطأ أثناء الحذف" });
    }
    if (this.changes === 0) {
      return res.status(404).json({ success: false, message: "المنتج غير موجود" });
    }
    res.json({ success: true });
  });
});
// --- End Products API Routes ---


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
