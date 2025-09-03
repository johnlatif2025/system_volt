# Mahmod Store - Node.js + Firestore Orders System

ميزات المشروع:
- تسجيل / دخول (اسم مستخدم + كلمة مرور) مخزن في Firestore مع تشفير كلمات المرور.
- لوحة تحكم موحّدة `dashboard.html` تتصرف كـ client أو admin حسب دور المستخدم.
- العميل يضيف طلبات على نفس الصفحة (نموذج) ويشوف قائمة طلباته وحالاتها (قيد المراجعة، متوفر، غير متوفر).
- المدير يرى كل الطلبات ويستطيع تغيير حالة التوفر ✔ / ✖.
- إشعارات داخل الموقع فقط (لا إرسال بريد عند تغيير الحالة).

## إعداد وتشغيل
1. ثبت الحزم:
   ```bash
   npm install
   ```
2. ضع `serviceAccountKey.json` في جذر المشروع أو عيّن متغير البيئة `GOOGLE_APPLICATION_CREDENTIALS` للمسار.
3. انسخ `.env.example` إلى `.env` وغيّر `JWT_SECRET` لقيمة قوية.
4. شغّل السيرفر:
   ```bash
   npm start
   ```
5. افتح المتصفح:
   - `http://localhost:3000/index.html` للتسجيل.
   - `http://localhost:3000/login.html` لتسجيل الدخول.
   - بعد تسجيل الدخول ستُحوَّل إلى `dashboard.html`.

## ملاحظات
- لا يُستخدم Firebase Authentication هنا؛ النظام يخزن المستخدمين في Firestore ضمن مجموعة `users`.
- الحقول في الـ order تتمثل كالآتي: name (الاسم الثلاثي), phones (مصفوفة رقمين), address, quantity, size, colors, priceNoShip, shipCost, totalPrice, commission, note, available (null|'available'|'unavailable'|'pending'), createdBy, createdAt
