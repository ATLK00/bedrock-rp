# BEDROCK-RP AI Development Pack

ไฟล์สำคัญ:

- `MASTER_PROMPT.md` — กฎและ architecture หลักสำหรับ AI coding
- `CHANGELOG_AI.md` — บันทึกทุกการแก้ไขในแต่ละรอบ
- `AI_HANDOFF.md` — สถานะล่าสุดสำหรับส่งต่อให้ AI ตัวอื่น

## วิธีใช้

1. นำ `MASTER_PROMPT.md` ให้ Claude/AI ตัวหลักอ่านก่อน
2. ให้ AI ทำงานใน repository จริง
3. ทุก iteration ต้องอัปเดต `CHANGELOG_AI.md`
4. ทุก iteration ต้องอัปเดต `AI_HANDOFF.md`
5. ก่อนเปลี่ยน AI ให้ส่งทั้ง repository + เอกสาร 3 ไฟล์นี้
6. AI ตัวใหม่ต้องอ่านและตรวจ code จริงก่อนทำงานต่อ

## หลักสำคัญ

เอกสารไม่ได้แทนการตรวจ code จริง AI ต้อง verify กับ repository ทุกครั้ง
