# DISPLAY

## ตั้งค่าการเชื่อมต่อในโค้ด

แก้ URL และรหัสที่ `display-config.js` ไฟล์เดียว ทั้งหน้ารีโมตและทีวีจะอ่านไฟล์นี้
อัตโนมัติ ไม่ต้องกรอกรหัสบนหน้าเว็บ ค่าที่เคยบันทึกไว้ใน browser จะไม่ทับค่าในโค้ด

ตั้ง `TV_DISPLAY_AUTH_TOKEN` ใน Apps Script → Project Settings → Script Properties
ให้ตรงกับ `controlAuthToken` ในไฟล์ตั้งค่า ใช้ `Code.gs` จาก repository นี้ แล้ว
Deploy → Manage deployments → Edit → New version เพื่ออัปเดต backend

เจ้าของระบบเลือกให้รหัสอยู่ในโค้ดเว็บสาธารณะ รหัสนี้จึงไม่ใช่ความลับและผู้ที่เปิดเว็บ
สามารถอ่านและใช้รหัสควบคุมได้ Backend ยังปฏิเสธคำขอที่รหัสไม่ตรงหรือไม่ได้ตั้งค่า
ข้อมูล Google Sheet ที่เผยแพร่สาธารณะยังอ่านได้ผ่าน Google Visualization โดยตรง
รหัสควบคุมไม่ได้เปลี่ยนสิทธิ์การแชร์ของ Google Sheet

คำสั่งควบคุมมีอายุ 60 วินาทีตามเวลาฝั่ง Apps Script และทีวีจำรหัสคำสั่งล่าสุด
แยกตาม backend/หมายเลขจอ จึงไม่ย้อนทำคำสั่งเดิมเมื่อเปิดหน้าใหม่
Autoplay เริ่มแบบหยุดเมื่อยังไม่เคยตั้งค่า ใช้ปุ่มเล่น/หยุดในรีโมตหรือคำสั่งเสียงได้

## ตรวจสอบ

```powershell
node --test performance.test.cjs
```

การทดสอบนี้ใช้ backend จำลอง ไม่ส่งคำสั่งไปทีวีจริง ดูวิธี build Android TV ใน `android-tv/README.md`
