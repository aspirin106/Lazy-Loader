# Lazy-Loader

ตัวกลาง MCP แบบ stdio ที่เปิด backend เมื่อเรียกใช้ เก็บเซสชันของตัวที่มี state และปิดตัวที่เริ่มใหม่ได้เมื่อว่าง

[English README](README.md) · [ค่าตั้งทั้งหมด](docs/CONFIGURATION.md) · [MIT License](LICENSE)

ใช้ Node.js 22 ขึ้นไป ไม่มี npm dependency เพิ่ม และไม่ต้อง `npm install` รุ่นนี้ทดสอบบน Windows ตัว gateway ไม่เปิดพอร์ตเครือข่ายและไม่ติดตั้ง service เบื้องหลัง

## การทำงาน

คุณสร้าง catalog ของ backend แต่ละตัวไว้ก่อน เมื่อ client เรียก initialize หรือค้นเครื่องมือ Gateway อ่าน metadata จาก catalog โดยไม่เปิด backend เมื่อมี tool call จึงเปิดเฉพาะ backend ที่ตรงชื่อ

Gateway หนึ่ง process อยู่ต่อหนึ่ง stdio connection การเชื่อมต่อคนละชุดมี backend session ของตัวเอง ไม่ใช่บริการกลางที่ทุกโปรเจกต์แชร์ process กัน และ gateway ยังต้องเปิดรอรับคำสั่ง

ชื่อเครื่องมือเป็น `server__tool` เช่น `files__inspect` เมื่อย้าย server เข้ามา ต้องปรับ allowlist และ approval policy ที่อ้างชื่อเครื่องมือเดิมด้วย

## เลือกว่าจะเก็บเซสชันหรือปิดเมื่อว่าง

| นโยบาย | ค่าที่ใช้ | ลักษณะงาน |
| --- | --- | --- |
| เปิดเมื่อเรียกครั้งแรก แล้วเก็บไว้ | `idleSeconds: 0`, `stateless: false` | REPL, browser, เกม, editor, terminal, binary session, watcher หรืองานที่ต้องใช้ handle และ job ID ต่อ |
| เปิดเมื่อเรียก แล้วปิดเมื่อว่าง | `idleSeconds: 30`, `stateless: true` | งานที่จบใน request และเริ่ม process ใหม่แล้วไม่เสีย state ที่จำเป็น |

หากยังไม่แน่ใจให้เก็บเซสชันไว้ก่อน `stateless: true` เป็นการยืนยันของผู้ดูแล Gateway ไม่วิเคราะห์หรือเลือกแทน และตั้งนโยบายต่อ backend ไม่ได้แยกต่อเครื่องมือ

งานเบื้องหลังอาจยังไม่จบแม้ MCP ตอบ job ID กลับมาแล้ว ห้ามใช้ idle shutdown กับงาน capture หรือ transfer ต่อเนื่องโดยยังไม่ได้ตรวจ lifecycle ของ backend นั้น

## เริ่มด้วยตัวจำลอง

รันจากโฟลเดอร์ repo โดยไม่ต้องติดตั้ง MCP จริง

```sh
git clone https://github.com/aspirin106/Lazy-Loader.git
cd Lazy-Loader
node --version
npm test
node gateway.mjs snapshot examples/demo.json stateless_demo
node gateway.mjs snapshot examples/demo.json session_demo
node gateway.mjs check examples/demo.json
```

ชุดทดสอบมี 23 tests และใช้ mock backend เท่านั้น ผล check ของ demo ต้องมี `valid: true`, `startedBackends: 0` และรายการ 8 กับ 11 เครื่องมือ ตัวแรกมี idle timeout 2 วินาที ตัวที่สองเก็บเซสชันหลังเริ่มใช้

Snapshot ตั้งใจเปิด backend เพื่ออ่าน metadata แล้วปิด การค้นเครื่องมือในการใช้งานปกติอ่าน catalog ที่เตรียมไว้ ไฟล์ catalog ผูกกับ launch settings จึงไม่รวมไว้ใน Git

## เพิ่ม backend จริง

1. ใช้ `examples/servers.template.json` เป็นแม่แบบสำหรับ `servers.json` ของคุณ
2. แก้พาธทั้งหมดและลบตัวอย่างที่ไม่ได้ใช้
3. ติดตั้ง dependency ของ backend เองและตรึงเวอร์ชัน
4. สร้างโฟลเดอร์ parent ของ catalog เช่น `catalogs`
5. เลือก idle policy ตาม state ที่ต้องรักษา
6. สร้าง snapshot ทีละ alias แล้วตรวจ config ทั้งชุด

```sh
node gateway.mjs snapshot servers.json your_alias
node gateway.mjs check servers.json
```

แทน `your_alias` ด้วยชื่อจริงใน config ทุก cwd ที่ตั้งไว้ต้องมีอยู่ แม้ยังไม่ได้เรียก backend นั้น

ใช้ executable จริง เช่น python.exe ของ venv หรือ node.exe กับ JavaScript entry point ตัวกลางใช้ `shell: false` ไม่รับ `.cmd` กับ `.bat` และไม่ขยาย `%VARIABLE%` ใน args อย่าใช้พาธ cache ชั่วคราวของ package เป็นการติดตั้งถาวร

ใช้ `inheritCwd: true` เมื่อ backend ต้องมองโปรเจกต์ของ client ใช้ `cwd` คงที่เมื่อ backend ต้องทำงานใน directory เฉพาะ ห้ามใช้สองค่านี้พร้อมกัน

MCP ที่เพิ่มใน client ภายหลังไม่ได้เข้า gateway ให้อัตโนมัติ ต้องลงทะเบียน เลือกนโยบาย และสร้าง catalog ของตัวนั้นก่อน

## เชื่อม Codex

แก้พาธตัวอย่างให้ตรงเครื่อง และทดสอบ backend ผ่าน gateway ก่อนเปิดใช้

```toml
[mcp_servers.lazy_gateway]
command = "C:/Program Files/nodejs/node.exe"
args = ["C:/path/to/Lazy-Loader/gateway.mjs", "serve", "C:/path/to/Lazy-Loader/servers.json"]
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 600
```

อย่าตรึง cwd ของ gateway เป็นโฟลเดอร์ติดตั้งหาก backend ต้องรับ cwd ของโปรเจกต์ ตั้ง timeout ให้ครอบคลุม cold startup และคำสั่งที่ใช้จริง ค่า 600 เป็นตัวอย่าง ไม่รับประกันเวลาของทุก backend

ปิด direct entry ที่ย้ายแล้วเพื่อไม่ให้เปิดซ้ำ เก็บคำสั่งเดิมไว้สำหรับย้อนกลับ และคง tool filters กับ approval policy เดิมด้วยชื่อใหม่ Gateway ไม่ย้ายข้อจำกัดเหล่านั้นให้อัตโนมัติ ตัวที่ต้องเชื่อมตรงกับ client สามารถเก็บไว้นอก gateway ได้

หลังแก้ config ให้เริ่ม MCP connection ใหม่ หากไม่มีปุ่ม reconnect ให้ปิดแล้วเปิด client เมื่อพร้อมหยุดงาน การแก้ไฟล์ไม่ย้ายเซสชันที่เปิดค้างอยู่

ให้ client เรียก Node โดยตรง ห้ามกรอง stdout เพราะช่องนี้ต้องมี MCP JSON-RPC เท่านั้น Gateway ส่ง log ไป stderr

## ข้อมูลลับและ config ส่วนตัว

ไม่ commit `servers.json` จริง, catalog, `.env`, credentials, log หรือไฟล์ backend ตรวจ staged files ก่อนทุก commit แม้มี `.gitignore` แล้ว

หาก backend ต้องใช้ค่าจาก host ให้ใส่ชื่อใน `envVars` ของ backend และส่งชื่อเดียวกันผ่าน `env_vars` ของ Codex อย่าคัดลอกค่า token, pipe หรือ host registration จากเครื่องอื่น

การแยก environment ครอบคลุมเฉพาะชื่อที่ประกาศเป็น managed envVars ตัวแปรอื่นยังสืบทอดตามปกติ กลไกนี้ไม่ใช่ sandbox สำหรับโค้ดที่ไม่เชื่อถือ

## ตรวจว่าใช้งานจริงได้

1. ตรวจ initialize และ tools/list ว่ายังไม่เปิด backend
2. เรียกคำสั่งอ่านสถานะที่ปลอดภัยผ่านชื่อใหม่
3. สำหรับตัวที่ปิดเมื่อว่าง ตรวจว่า PID จบหลังครบเวลา และการเรียกใหม่เริ่ม process ใหม่
4. สำหรับตัวที่เก็บเซสชัน ตรวจว่าใช้ PID และ state เดิมหลังว่าง
5. ปิด client แล้วตรวจ process ที่การทดสอบสร้าง
6. ตรวจซ้ำภายใน client จริงหลังเริ่ม connection ใหม่

Check แบบออฟไลน์ไม่ยืนยันว่า executable, dependency, permission หรือ editor พร้อมใช้งาน การเห็นชื่อเครื่องมือยืนยันเพียงการอ่าน catalog ไม่ใช่การทำงานของทุกฟีเจอร์

## ข้อจำกัด

- รองรับ stdio เท่านั้น ไม่มี HTTP, SSE หรือ daemon แชร์ backend ข้ามทุก connection
- ทดสอบบน Windows ยังไม่ยืนยัน cleanup บน Linux และ macOS
- `idleSeconds: 0` ป้องกันการปิดเพราะว่าง ไม่ป้องกัน state หายจาก crash, timeout, active cancellation หรือปิด client
- ไม่ replay คำสั่งหลัง error เพราะอาจเปลี่ยนข้อมูลสำเร็จแล้วก่อนการตอบกลับขาดหาย ต้องตรวจผลจริงก่อนเรียกซ้ำ
- ปิด stdin ของ backend ก่อน หากไม่จบใน 750 ms จึงปิดเฉพาะ owned process tree บน Windows ไม่มี Windows Job Object supervisor และไม่รับประกัน cleanup หลัง force-kill gateway หรือ process ลูกที่ detach
- จำกัด JSON หนึ่งบรรทัด 16 MiB และไม่รองรับ task-augmented calls
- ยังไม่ refresh prompt กับ resource catalog ที่เปลี่ยนระหว่างเซสชันครบอัตโนมัติ และ resource subscription capability aggregation ยังไม่ครบ
- experimental extensions และ native host callbacks ต้องทดสอบกับ client จริง
- ไม่ส่งต่อ stderr ของ backend เพื่อเลี่ยงการคัดลอกข้อมูลลับจาก log อาจต้องตรวจ backend แยกเมื่อเริ่มไม่สำเร็จ

รุ่น 0.2.1 แก้ false positive `MCP catalog changed` เมื่อ snapshot กับ client เจรจาคนละ protocol ที่รองรับ โดยยังคงการตรวจ schema, server identity และ instructions

ดู [README ภาษาอังกฤษ](README.md#troubleshooting) สำหรับตารางแก้ปัญหา และ [Configuration reference](docs/CONFIGURATION.md) สำหรับค่า config ทั้งหมด

## License

ใช้ [MIT License](LICENSE) โปรแกรม backend และ dependency ของ backend ไม่รวมอยู่ใน repo นี้ และยังอยู่ภายใต้ license ของตัวเอง
