# DISPLAY

## ตั้งค่ารหัสควบคุมจอ

1. ใน Apps Script → Project Settings → Script Properties ตั้ง `TV_DISPLAY_AUTH_TOKEN`
   เป็นรหัสสุ่มยาวอย่างน้อย 32 ตัวอักษร เก็บรหัสนี้เป็นส่วนตัว
2. ใช้ `Code.gs` จาก repository นี้ แล้ว Deploy → Manage deployments → Edit → New version
   เพื่อให้ URL `/exec` ใช้ backend รุ่นใหม่ (บันทึกโค้ดอย่างเดียวไม่เปลี่ยน deployment)
3. หน้ารีโมตเปิด **ตั้งค่าการเชื่อมต่อ** ใส่ URL `/exec` และรหัส แล้วบันทึก
4. หน้าแสดงผลเปิดตั้งค่าจอ ใส่ **รหัสควบคุมจอ** เดียวกัน แล้วบันทึก ทำซ้ำทุกเครื่อง/ทีวี
   ที่ใช้คนละ browser profile เครื่องเดียวกันใช้ localStorage ร่วมกัน

Backend ปฏิเสธการควบคุมเมื่อยังไม่ตั้งรหัส ห้ามใส่รหัสจริงใน Git, HTML, ลิงก์เปิดจอ
หรือ `version.json` รหัสที่บันทึกอยู่ใน browser profile ของแต่ละเครื่อง
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
