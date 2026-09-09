// ==========================================
// 🏎️ car_engine.js — Engine & Transmission System (Phase 2)
// แยกออกมาจาก car_physics.js เพื่อไม่ให้ physics loop ยาวเกินไป
// ตามสถาปัตยกรรมที่แนะนำใน VEHICLE_SYSTEM.md
//
// ฟังก์ชันทั้งหมดในไฟล์นี้เป็น pure-ish function: รับ state + config + input
// แล้วคืนค่าใหม่ ไม่แตะ world/entity โดยตรง (ยกเว้น sound trigger ที่ทำผ่าน callback)
// ==========================================

/**
 * คำนวณ RPM ปัจจุบันจาก speedRatio ภายใน "ช่วงความเร็วของเกียร์นั้น ๆ"
 * แนวคิด: แต่ละเกียร์ครอบคลุมช่วง speedRatio ที่เท่ากัน (1/จำนวนเกียร์)
 * RPM จะไล่จาก idle -> redline ภายในช่วงของเกียร์นั้น ไม่ใช่เส้นตรงจาก 0-topSpeed ทั้งคัน
 */
function calcTargetRPM(gear, speedRatio, config) {
    const forwardGearCount = config.gearRatios.length - 1; // index 0 คือเกียร์ถอย
    if (gear <= 0) {
        // เกียร์ว่าง/ถอยหลัง: RPM ผูกกับ throttle มากกว่า speed ตรง ๆ (จัดการโดยผู้เรียก)
        return config.idleRPM;
    }

    const bandSize = 1.0 / forwardGearCount;
    const bandStart = (gear - 1) * bandSize;
    const posInBand = Math.max(0, Math.min(1, (speedRatio - bandStart) / bandSize));

    return config.idleRPM + (config.redlineRPM - config.idleRPM) * posInBand;
}

/**
 * ตัดสินใจว่าควรเปลี่ยนเกียร์ขึ้น/ลงหรือไม่ ด้วย hysteresis (shiftUp/shiftDown ratio ต่างกัน)
 * ป้องกันอาการเปลี่ยนเกียร์รัว ๆ (gear hunting)
 */
export function computeGear(prevGear, speedRatio, throttleInput, rpm, config, shiftTimerRemaining) {
    const forwardGearCount = config.gearRatios.length - 1;

    // ถอยหลัง / เกียร์ว่าง คงตรรกะเดิม (ผูกกับทิศ velocity ที่ผู้เรียกส่งมาแล้วผ่าน prevGear<0 เคส)
    if (prevGear < 0) return prevGear;
    if (Math.abs(speedRatio) < 0.02 && throttleInput === 0) return 0;

    if (shiftTimerRemaining > 0) return prevGear; // อยู่ระหว่าง shift delay ห้ามเปลี่ยนซ้ำ

    let gear = Math.max(1, prevGear || 1);
    const shiftUpRpm = config.redlineRPM * config.shiftUpRpmRatio;
    const shiftDownRpm = config.redlineRPM * config.shiftDownRpmRatio;

    if (rpm >= shiftUpRpm && gear < forwardGearCount) {
        gear += 1;
    } else if (rpm <= shiftDownRpm && gear > 1) {
        gear -= 1;
    }
    return gear;
}

/**
 * คำนวณ torque multiplier แบบง่าย (torque curve): มากสุดช่วงกลาง RPM, ลดลงใกล้ redline และตอน idle
 * คืนค่า 0.0 - 1.0 ไว้คูณกับ acceleration หลัก
 */
export function torqueCurveMultiplier(rpm, config) {
    const rpmRatio = Math.max(0, Math.min(1, (rpm - config.idleRPM) / (config.redlineRPM - config.idleRPM)));
    // โค้งรูประฆังคร่าว ๆ: จุดสูงสุดราว 55-65% ของ rev range
    const peak = 0.6;
    const width = 0.55;
    const dist = Math.abs(rpmRatio - peak) / width;
    const curve = Math.max(0.35, 1.0 - dist * dist); // อย่างน้อย 0.35 กันดับกลางทาง
    return curve;
}

/**
 * แรงหน่วงจาก engine braking (ตอนถอนคันเร่งแต่เข้าเกียร์อยู่)
 * ยิ่งเกียร์ต่ำ + RPM สูง ยิ่งหน่วงแรง (เหมือนรถจริง)
 */
export function engineBrakingForce(gear, rpm, config) {
    if (gear <= 0) return 0;
    const rpmRatio = Math.max(0, Math.min(1, rpm / config.redlineRPM));
    const gearFactor = 1.0 / gear; // เกียร์ต่ำหน่วงแรงกว่าเกียร์สูง
    return config.engineBrakeCoef * rpmRatio * gearFactor;
}

/**
 * ห่อรวม logic ของ Phase 2 ทั้งหมดไว้ในฟังก์ชันเดียวให้ car_physics.js เรียกใช้ง่าย ๆ
 * @param {object} params - { gear, velocity, activeMaxSpeed, throttleInput, config, shiftTimer, isReverse }
 * @returns {object} { gear, rpm, torqueMult, engineBrakeForce, didShiftUp }
 */
export function updateEngineTransmission(params) {
    const { gear, velocity, activeMaxSpeed, throttleInput, config, shiftTimer } = params;

    let speedRatio = activeMaxSpeed > 0 ? Math.min(1, Math.abs(velocity) / activeMaxSpeed) : 0;
    if (isNaN(speedRatio)) speedRatio = 0;

    let workingGear = gear;
    let rpm;

    if (velocity < -0.05) {
        // ถอยหลัง: ผูก RPM กับ throttle + speed แบบง่าย ไม่ใช้ gearRatios arrayช่วงถอย
        workingGear = -1;
        rpm = config.idleRPM + (config.redlineRPM - config.idleRPM) * speedRatio * 0.6;
    } else if (Math.abs(velocity) < 0.05 && throttleInput === 0) {
        workingGear = 0;
        rpm = config.idleRPM;
    } else {
        if (workingGear <= 0) workingGear = 1;
        rpm = calcTargetRPM(workingGear, speedRatio, config);
        // throttle ช่วยให้ RPM ตอบสนองไวขึ้นเล็กน้อยตอนเร่ง (ไม่ใช่แค่ผูกกับ speed เฉย ๆ)
        if (throttleInput > 0) rpm += (config.redlineRPM - rpm) * 0.03;

        const newGear = computeGear(workingGear, speedRatio, throttleInput, rpm, config, shiftTimer);
        workingGear = newGear;
    }

    rpm = Math.max(config.idleRPM * 0.9, Math.min(config.redlineRPM * 1.05, rpm));
    if (isNaN(rpm) || !isFinite(rpm)) rpm = config.idleRPM;

    const torqueMult = torqueCurveMultiplier(rpm, config);
    const engineBrakeForce = engineBrakingForce(workingGear, rpm, config);

    return { gear: workingGear, rpm, torqueMult, engineBrakeForce };
}
