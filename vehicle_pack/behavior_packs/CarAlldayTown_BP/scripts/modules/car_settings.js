// ==========================================
// 🛠️ ไฟล์สำหรับปรับแต่งรถ (Advanced Car Settings)
// v2.1.0 — เพิ่ม Engine/Transmission/Terrain config (Phase 2-3)
// ==========================================

const DEFAULT_CONFIG = {
    // --- เดิม (Phase 1 / Core) ---
    maxSpeed: 2.2,
    acceleration: 0.012,
    brakeForce: 0.06,      // 🌟 แรงเบรก (ยิ่งเยอะยิ่งหยุดไว)
    baseFriction: 1.0,     // 🌟 การเกาะพื้น (1.0 คือปกติ, น้อยกว่านี้จะลื่น)
    steerMaxAngle: 40.0,
    steerSensitivity: 0.2,
    turnSpeedMultiplier: 0.8,
    mass: 1200.0,
    modelDirection: -1,

    // --- ใหม่ (Phase 2: Engine / Transmission) ---
    idleRPM: 800,
    redlineRPM: 7000,
    // ตำแหน่ง [0] = เกียร์ถอยหลัง, ที่เหลือ index 1..N = เกียร์ 1..N
    gearRatios: [3.6, 3.6, 2.1, 1.4, 1.05, 0.82],
    finalDrive: 3.9,
    engineBrakeCoef: 0.035,     // แรงหน่วงจากเครื่องยนต์ตอนถอนคันเร่ง
    shiftUpRpmRatio: 0.88,      // % ของ redline ที่จะเปลี่ยนเกียร์ขึ้น
    shiftDownRpmRatio: 0.32,    // % ของ redline ที่จะเปลี่ยนเกียร์ลง
    shiftDelayTicks: 6,

    // --- ใหม่ (Phase 3: Tire / Grip) ---
    frontGrip: 1.0,
    rearGrip: 1.0,
    handbrakeRearGripMultiplier: 0.35, // ดึงมือเบรก → ลด grip ล้อหลังเหลือ 35%

    // --- ใหม่ (Phase 4: Damage) ---
    maxEngineHealth: 100,
    maxSuspensionHealth: 100,
    collisionDamagePerSpeed: 18, // ความเสียหาย body ต่อหน่วยความเร็วชนตรง ๆ

    // --- ใหม่ (Phase 6: Performance LOD) ---
    fuelCapacity: 100
};

// ตารางค่า grip ต่อชนิดพื้นผิว (Phase 3: Terrain)
// แยก accel / brake / corner ตามที่โจทย์กำหนด แทนตัวคูณเดียวแบบเดิม
export const TERRAIN_GRIP_TABLE = [
    { match: "ice",     accel: 0.18, brake: 0.15, corner: 0.20, rollingResistance: 0.01 },
    { match: "sand",    accel: 0.55, brake: 0.60, corner: 0.55, rollingResistance: 0.05 },
    { match: "gravel",  accel: 0.65, brake: 0.70, corner: 0.65, rollingResistance: 0.03 },
    { match: "mud",     accel: 0.45, brake: 0.50, corner: 0.45, rollingResistance: 0.06 },
    { match: "grass",   accel: 0.90, brake: 0.90, corner: 0.90, rollingResistance: 0.015 },
    // ค่า default (ถนน/หิน/อื่น ๆ) อยู่ท้ายสุดเป็น fallback เสมอ — อย่าลบ
    { match: "",        accel: 1.0,  brake: 1.0,  corner: 1.0,  rollingResistance: 0.0 }
];

export const CAR_CONFIGS = {
    "megaverse:buggy": {
        ...DEFAULT_CONFIG,
        maxSpeed: 2.5,
        acceleration: 0.014,
        brakeForce: 0.08,  // Buggy เบรกจิกกว่าปกติ
        baseFriction: 1.1, // Buggy เกาะถนนดีกว่าปกติ
        mass: 600.0,

        idleRPM: 900,
        redlineRPM: 6800,
        gearRatios: [3.3, 3.3, 1.9, 1.3, 1.0, 0.78],
        finalDrive: 4.1,
        frontGrip: 1.05,
        rearGrip: 1.0
    }
};

// ==========================================
// 🌍 Terrain Grip Lookup (เดิมอยู่แยกไฟล์ car_terrain.js — รวมมาไว้ที่นี่เพราะใช้ TERRAIN_GRIP_TABLE ร่วมกัน)
// หาแถว grip ที่ตรงกับ block typeId ที่สุด (จับคู่แบบ substring match)
// ตัวสุดท้ายใน TERRAIN_GRIP_TABLE เป็น fallback (match: "") เสมอ
// ==========================================
export function getTerrainGrip(blockTypeId) {
    if (!blockTypeId) return TERRAIN_GRIP_TABLE[TERRAIN_GRIP_TABLE.length - 1];
    for (const row of TERRAIN_GRIP_TABLE) {
        if (row.match && blockTypeId.includes(row.match)) return row;
    }
    return TERRAIN_GRIP_TABLE[TERRAIN_GRIP_TABLE.length - 1];
}
