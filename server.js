const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const nodemailer = require("nodemailer");
const path = require("path");
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();

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
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://7oda-store-production.up.railway.app'], // تأكد من إضافة نطاق تطبيقك هنا
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// إعداد الجلسة
app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret-key', // استخدم مفتاح سري قوي من .env
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // استخدم true في الإنتاج لـ HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 ساعة
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
});
const upload = multer({ storage });

// إعداد البريد الإلكتروني مع SMTP
const transporter = nodemailer.createTransport({
  service: 'gmail', // يمكنك استخدام خدمات أخرى مثل 'outlook', 'yahoo'
  auth: {
    user: process.env.SMTP_USER, // بريدك الإلكتروني من .env
    pass: process.env.SMTP_PASS  // كلمة مرور التطبيق من .env
  },
});

// إنشاء الجداول
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    playerId TEXT,
    email TEXT,
    type TEXT,          -- 'UC' أو 'Bundle'
    ucAmount TEXT,      -- عدد الشدات إذا كان النوع UC
    bundle TEXT,        -- اسم الحزمة إذا كان النوع Bundle
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

  // جدول جديد لخيارات الشدات (UC)
  db.run(`CREATE TABLE IF NOT EXISTS uc_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uc_amount INTEGER NOT NULL,
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

// API Routes للعملاء (الطلبات، الاستفسارات، الاقتراحات)
app.post("/api/order", upload.single('screenshot'), (req, res) => {
  const { name, playerId, email, ucAmount, bundle, totalAmount, transactionId } = req.body;

  // التحقق من الحقول المطلوبة
  if (!name || !playerId || !email || !transactionId || !totalAmount || (!ucAmount && !bundle)) {
    return res.status(400).json({ success: false, message: "جميع الحقول المطلوبة غير مكتملة." });
  }

  // تحديد نوع الطلب (UC أو Bundle)
  const type = ucAmount ? "UC" : "Bundle";
  const screenshot = req.file ? `/uploads/${req.file.filename}` : null;

  db.run(
    `INSERT INTO orders (name, playerId, email, type, ucAmount, bundle, totalAmount, transactionId, screenshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, playerId, email, type, ucAmount, bundle, totalAmount, transactionId, screenshot],
    function(err) {
      if (err) {
        console.error("Error inserting order:", err.message);
        return res.status(500).json({ success: false, message: "حدث خطأ أثناء حفظ الطلب في قاعدة البيانات." });
      }
      res.json({ success: true, id: this.lastID, message: "تم استلام طلبك بنجاح!" });
    }
  );
});

app.post("/api/inquiry", async (req, res) => {
  const { name, email, message } = req.body; // أضفت 'name' هنا بناءً على نموذج الاستفسار في index.html

  if (!name || !email || !message) {
    return res.status(400).json({ success: false, message: "الاسم والبريد والرسالة مطلوبون." });
  }

  try {
    db.run(
      "INSERT INTO inquiries (email, message) VALUES (?, ?)",
      [email, message], // لا يتم تخزين الاسم في جدول inquiries حاليًا
      async function(err) {
        if (err) {
          console.error("Error inserting inquiry:", err.message);
          return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات أثناء حفظ الاستفسار." });
        }

        // إرسال بريد إلكتروني للمشرف بوجود استفسار جديد
        await transporter.sendMail({
          from: `"فريق الدعم" <${process.env.SMTP_USER}>`,
          to: process.env.SMTP_USER, // إرسال إلى بريد المشرف
          subject: "استفسار جديد من العميل",
          html: `
            <div dir="rtl">
              <h2 style="color: #ffa726;">استفسار جديد</h2>
              <p><strong>الاسم:</strong> ${name}</p>
              <p><strong>البريد:</strong> ${email}</p>
              <p><strong>الرسالة:</strong></p>
              <p style="background: #f5f5f5; padding: 10px; border-right: 3px solid #ffa726;">${message}</p>
            </div>
          `,
        });

        res.json({ success: true, message: "تم إرسال استفسارك بنجاح!" });
      }
    );
  } catch (error) {
    console.error("Error sending inquiry email:", error);
    res.status(500).json({ success: false, message: "فشل إرسال الاستفسار أو البريد الإلكتروني." });
  }
});

app.post("/api/suggestion", async (req, res) => {
  const { name, contact, message } = req.body;

  if (!name || !contact || !message) {
    return res.status(400).json({ success: false, message: "جميع حقول الاقتراح مطلوبة." });
  }

  try {
    db.run(
      "INSERT INTO suggestions (name, contact, message) VALUES (?, ?, ?)",
      [name, contact, message],
      async function(err) {
        if (err) {
          console.error("Error inserting suggestion:", err.message);
          return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات أثناء حفظ الاقتراح." });
        }

        // إرسال بريد إلكتروني للمشرف بوجود اقتراح جديد
        await transporter.sendMail({
          from: `"اقتراح جديد" <${process.env.SMTP_USER}>`,
          to: process.env.SMTP_USER, // إرسال إلى بريد المشرف
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

        res.json({ success: true, message: "تم إرسال اقتراحك بنجاح!" });
      }
    );
  } catch (error) {
    console.error("Error sending suggestion email:", error);
    res.status(500).json({ success: false, message: "فشل إرسال الاقتراح أو البريد الإلكتروني." });
  }
});

// API Routes للمشرف (تتطلب تسجيل دخول المشرف)
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    req.session.admin = true;
    return res.json({ success: true, message: "تم تسجيل الدخول بنجاح." });
  }
  res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Error destroying session:", err.message);
      return res.status(500).json({ success: false, message: "فشل تسجيل الخروج." });
    }
    res.json({ success: true, message: "تم تسجيل الخروج بنجاح." });
  });
});

// Middleware للتحقق من صلاحيات المشرف
function isAdmin(req, res, next) {
  if (req.session.admin) {
    next();
  } else {
    res.status(403).json({ success: false, message: "غير مصرح لك بالوصول." });
  }
}

app.get("/api/admin/orders", isAdmin, (req, res) => {
  db.all("SELECT * FROM orders ORDER BY id DESC", (err, rows) => {
    if (err) {
      console.error("Error fetching orders:", err.message);
      return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات أثناء جلب الطلبات." });
    }
    res.json({ success: true, data: rows });
  });
});

app.get("/api/admin/inquiries", isAdmin, (req, res) => {
  db.all("SELECT * FROM inquiries ORDER BY created_at DESC", (err, rows) => {
    if (err) {
      console.error("Error fetching inquiries:", err.message);
      return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات أثناء جلب الاستفسارات." });
    }
    res.json({ success: true, data: rows });
  });
});

app.get("/api/admin/suggestions", isAdmin, (req, res) => {
  db.all("SELECT * FROM suggestions ORDER BY created_at DESC", (err, rows) => {
    if (err) {
      console.error("Error fetching suggestions:", err.message);
      return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات أثناء جلب الاقتراحات." });
    }
    res.json({ success: true, data: rows });
  });
});

app.post("/api/admin/update-status", isAdmin, (req, res) => {
  const { id, status } = req.body;
  if (!id || !status) {
    return res.status(400).json({ success: false, message: "معرّف الطلب والحالة مطلوبان." });
  }

  db.run(
    "UPDATE orders SET status = ? WHERE id = ?",
    [status, id],
    function(err) {
      if (err) {
        console.error("Error updating order status:", err.message);
        return res.status(500).json({ success: false, message: "حدث خطأ أثناء تحديث حالة الطلب." });
      }
      if (this.changes === 0) {
        return res.status(404).json({ success: false, message: "الطلب غير موجود." });
      }
      res.json({ success: true, message: "تم تحديث حالة الطلب بنجاح." });
    }
  );
});

app.delete("/api/admin/delete-order", isAdmin, (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, message: "معرّف الطلب مطلوب." });
  }

  db.run("DELETE FROM orders WHERE id = ?", [id], function(err) {
    if (err) {
      console.error("Error deleting order:", err.message);
      return res.status(500).json({ success: false, message: "حدث خطأ أثناء حذف الطلب." });
    }
    if (this.changes === 0) {
      return res.status(404).json({ success: false, message: "الطلب غير موجود." });
    }
    res.json({ success: true, message: "تم حذف الطلب بنجاح." });
  });
});

app.delete("/api/admin/delete-inquiry", isAdmin, (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, message: "معرّف الاستفسار مطلوب." });
  }

  db.run("DELETE FROM inquiries WHERE id = ?", [id], function(err) {
    if (err) {
      console.error("Error deleting inquiry:", err.message);
      return res.status(500).json({ success: false, message: "حدث خطأ أثناء حذف الاستفسار." });
    }
    if (this.changes === 0) {
      return res.status(404).json({ success: false, message: "الاستفسار غير موجود." });
    }
    res.json({ success: true, message: "تم حذف الاستفسار بنجاح." });
  });
});

app.delete("/api/admin/delete-suggestion", isAdmin, (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, message: "معرّف الاقتراح مطلوب." });
  }

  db.run("DELETE FROM suggestions WHERE id = ?", [id], function(err) {
    if (err) {
      console.error("Error deleting suggestion:", err.message);
      return res.status(500).json({ success: false, message: "حدث خطأ أثناء حذف الاقتراح." });
    }
    if (this.changes === 0) {
      return res.status(404).json({ success: false, message: "الاقتراح غير موجود." });
    }
    res.json({ success: true, message: "تم حذف الاقتراح بنجاح." });
  });
});

app.post("/api/admin/reply-inquiry", isAdmin, async (req, res) => {
  const { inquiryId, email, message, reply } = req.body;
  if (!inquiryId || !email || !message || !reply) {
    return res.status(400).json({ success: false, message: "جميع حقول الرد مطلوبة." });
  }

  try {
    await transporter.sendMail({
      from: `"فريق الدعم" <${process.env.SMTP_USER}>`,
      to: email,
      subject: "رد على استفسارك من 7ODA STORE",
      html: `
        <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 20px; border-radius: 8px;">
          <h2 style="color: #ffa726; text-align: center;">شكراً لتواصلك معنا</h2>
          <p style="font-size: 1.1rem; color: #555;"><strong>استفسارك الأصلي:</strong></p>
          <p style="background: #f5f5f5; padding: 15px; border-right: 4px solid #ffa726; border-radius: 5px; margin-bottom: 20px;">${message}</p>
          <h3 style="color: #2196F3; font-size: 1.2rem;">رد فريق الدعم:</h3>
          <p style="background: #e3f2fd; padding: 15px; border-right: 4px solid #2196F3; border-radius: 5px;">${reply}</p>
          <hr style="margin-top: 30px; border-color: #eee;">
          <p style="text-align: center; color: #777; font-size: 0.9rem;">مع تحيات فريق 7ODA STORE</p>
        </div>
      `
    });

    db.run("UPDATE inquiries SET status = 'تم الرد' WHERE id = ?", [inquiryId], function(err) {
      if (err) {
        console.error("Error updating inquiry status:", err.message);
        return res.status(500).json({ success: false, message: "فشل تحديث حالة الاستفسار بعد الرد." });
      }
      res.json({ success: true, message: "تم إرسال الرد وتحديث حالة الاستفسار بنجاح." });
    });
  } catch (error) {
    console.error("Error sending reply email:", error);
    res.status(500).json({ success: false, message: "فشل إرسال الرد عبر البريد الإلكتروني." });
  }
});

app.post("/api/admin/send-message", isAdmin, async (req, res) => {
  const { email, subject, message } = req.body;
  if (!email || !subject || !message) {
    return res.status(400).json({ success: false, message: "جميع حقول الرسالة مطلوبة." });
  }

  try {
    await transporter.sendMail({
      from: `"7ODA STORE" <${process.env.SMTP_USER}>`,
      to: email,
      subject: subject,
      html: `
        <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 20px; border-radius: 8px;">
          <h2 style="color: #ffa726; text-align: center;">${subject}</h2>
          <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; border-right: 4px solid #2196F3; margin-top: 20px;">
            ${message.replace(/\n/g, '<br>')}
          </div>
          <hr style="margin-top: 30px; border-color: #eee;">
          <p style="text-align: center; color: #777; font-size: 0.9rem;">مع تحيات فريق 7ODA STORE</p>
        </div>
      `
    });

    res.json({ success: true, message: "تم إرسال الرسالة بنجاح." });
  } catch (error) {
    console.error("Error sending direct message:", error);
    res.status(500).json({ success: false, message: "فشل إرسال الرسالة المباشرة." });
  }
});

// --- UC Options API Routes ---
// Get all UC options for client (public)
app.get("/api/uc-options", (req, res) => {
  db.all("SELECT * FROM uc_options ORDER BY uc_amount ASC", (err, rows) => {
    if (err) {
      console.error("Error fetching public UC options:", err.message);
      return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات أثناء جلب خيارات الشدات." });
    }
    res.json({ success: true, data: rows });
  });
});

// Admin: Get all UC options (requires admin session)
app.get("/api/admin/uc-options", isAdmin, (req, res) => {
  db.all("SELECT * FROM uc_options ORDER BY uc_amount ASC", (err, rows) => {
    if (err) {
      console.error("Error fetching admin UC options:", err.message);
      return res.status(500).json({ success: false, message: "خطأ في قاعدة البيانات أثناء جلب خيارات الشدات للمشرف." });
    }
    res.json({ success: true, data: rows });
  });
});

// Admin: Add a new UC option
app.post("/api/admin/uc-options", isAdmin, (req, res) => {
  const { uc_amount, price, image_url } = req.body;
  if (!uc_amount || !price || !image_url) {
    return res.status(400).json({ success: false, message: "جميع حقول الشدة مطلوبة." });
  }

  db.run(
    "INSERT INTO uc_options (uc_amount, price, image_url) VALUES (?, ?, ?)",
    [uc_amount, price, image_url],
    function(err) {
      if (err) {
        console.error("Error adding UC option:", err.message);
        return res.status(500).json({ success: false, message: "حدث خطأ أثناء إضافة الشدة." });
      }
      res.json({ success: true, id: this.lastID, message: "تم إضافة الشدة بنجاح." });
    }
  );
});

// Admin: Update an existing UC option
app.put("/api/admin/uc-options/:id", isAdmin, (req, res) => {
  const { id } = req.params;
  const { uc_amount, price, image_url } = req.body;
  if (!uc_amount || !price || !image_url) {
    return res.status(400).json({ success: false, message: "جميع حقول الشدة مطلوبة للتحديث." });
  }

  db.run(
    "UPDATE uc_options SET uc_amount = ?, price = ?, image_url = ? WHERE id = ?",
    [uc_amount, price, image_url, id],
    function(err) {
      if (err) {
        console.error("Error updating UC option:", err.message);
        return res.status(500).json({ success: false, message: "حدث خطأ أثناء تحديث الشدة." });
      }
      if (this.changes === 0) {
        return res.status(404).json({ success: false, message: "الشدة غير موجودة." });
      }
      res.json({ success: true, message: "تم تحديث الشدة بنجاح." });
    }
  );
});

// Admin: Delete a UC option
app.delete("/api/admin/uc-options/:id", isAdmin, (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM uc_options WHERE id = ?", [id], function(err) {
    if (err) {
      console.error("Error deleting UC option:", err.message);
      return res.status(500).json({ success: false, message: "حدث خطأ أثناء حذف الشدة." });
    }
    if (this.changes === 0) {
      return res.status(404).json({ success: false, message: "الشدة غير موجودة." });
    }
    res.json({ success: true, message: "تم حذف الشدة بنجاح." });
  });
});
// --- End UC Options API Routes ---


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
