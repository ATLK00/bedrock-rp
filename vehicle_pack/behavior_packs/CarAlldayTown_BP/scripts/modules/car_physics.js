// ==========================================
// 🚙 car_physics.js — Vehicle Physics Orchestrator
// v2.1.0
//
// เปลี่ยนแปลงหลักจากเวอร์ชันเดิม (ดู CHANGELOG_VEHICLE.md ประกอบ):
//   - Phase 2: ผูก Engine/Transmission จริง (RPM, gear ratio, torque curve, engine braking) ผ่าน car_engine.js
//   - Phase 3: Terrain grip แยก accel/brake/corner ผ่าน car_terrain.js, เพิ่ม Handbrake
//   - Phase 4: Damage system เบื้องต้น (engine_health, suspension_health, body damage จากการชน)
//   - Phase 6: รองรับพารามิเตอร์ updateTier สำหรับ LOD (ดู scripts/main.js)
//
// โครงสร้าง raycast/suspension/tire-burst/drift/weight-transfer/air-physics เดิม "คงไว้ตามเดิม"
// ตามกฎห้ามทำระบบเดิมพัง มีการแตะเฉพาะจุดที่จำเป็นต่อฟีเจอร์ใหม่เท่านั้น
// ==========================================

import { world } from "@minecraft/server";
import { CAR_CONFIGS, getTerrainGrip } from "./car_settings.js";
import { updateEngineTransmission } from "./car_engine.js";

const suspensionStates = new Map();

export function updateCarPhysics(car, updateTier = "active") {
    try { const testLoc = car.location; } catch (e) { return; }

    if (!suspensionStates.has(car.id)) {
        suspensionStates.set(car.id, {
            terrainPitch: 0, terrainRoll: 0, weightTransfer: 0,
            wasInAir: false, shiftTimer: 0, soundTimer: 0, lastDriverId: null
        });
    }
    const state = suspensionStates.get(car.id);

    // 'far'/'empty' tier: ลดจำนวน raycast/entity-query ตาม Phase 6 (Performance)
    const isReducedTier = (updateTier === "far" || updateTier === "empty");

    let input = { x: 0, y: 0 };
    let isBraking = false;
    let isHandbrake = false;
    let driver = null;

    const rideable = car.getComponent("rideable");
    if (rideable) {
        const riders = rideable.getRiders();
        if (riders.length > 0) {
            driver = riders[0];
            input = driver.inputInfo.getMovementVector();
            isBraking = driver.isJumping;
            // Phase 3: Handbrake — ใช้ isSneaking เป็นตัวรับ input เพราะ Bedrock Script API
            // ยังไม่มี input channel เฉพาะสำหรับ "handbrake" บน rideable component
            // ข้อจำกัด: ต้องทดสอบจริงว่า isSneaking อ่านค่าได้ระหว่างนั่งบน rideable หรือไม่ (Not runtime-tested in Bedrock)
            try { isHandbrake = driver.isSneaking === true; } catch (e) { isHandbrake = false; }
        }
    }

    // 🔧 แก้บั๊ก "ลงรถแล้ว UI ไม่หาย" — เดิมพึ่งพา timeout ของ hud_system.js อย่างเดียว (ช้า ~0.5 วิ)
    // ตอนนี้เคลียร์ทันทีตรงจุดที่รู้ว่าคนขับ "เพิ่งลงจากรถ" (มี lastDriverId แต่ตอนนี้ไม่มี driver แล้ว/คนละคน)
    if (state.lastDriverId && (!driver || driver.id !== state.lastDriverId)) {
        try {
            const exitedPlayer = world.getEntity(state.lastDriverId);
            if (exitedPlayer && exitedPlayer.isValid()) {
                exitedPlayer.setDynamicProperty("car_hud_string", "car:off ");
                exitedPlayer.removeTag("driving_ui");
                exitedPlayer.setDynamicProperty("ui_tick", 100);
                // exitedPlayer.onScreenDisplay.setActionBar(""); // ปิดใช้งานแล้ว (v2.5.0 เลิกใช้ ActionBar)
            }
        } catch (e) { }
    }
    state.lastDriverId = driver ? driver.id : null;

    const defaultConfig = CAR_CONFIGS[car.typeId] || CAR_CONFIGS["megaverse:buggy"] || {};

    let maxSpeed = defaultConfig.maxSpeed || 0.8;
    let accel = defaultConfig.acceleration || 0.08;
    let brakePower = defaultConfig.brakeForce || 0.06;
    let traction = defaultConfig.baseFriction || 1.0;
    let steerMax = defaultConfig.steerMaxAngle || 40.0;
    let steerMode = 0;

    if (driver && driver.typeId === "minecraft:player") {
        maxSpeed = driver.getDynamicProperty("tune:speed") ?? maxSpeed;
        accel = driver.getDynamicProperty("tune:accel") ?? accel;
        brakePower = driver.getDynamicProperty("tune:brake") ?? brakePower;
        traction = driver.getDynamicProperty("tune:traction") ?? traction;
        steerMax = driver.getDynamicProperty("tune:steer") ?? steerMax;
        steerMode = driver.getDynamicProperty("tune:steerMode") ?? 0;
    } else {
        maxSpeed = car.getDynamicProperty("last:speed") ?? maxSpeed;
        accel = car.getDynamicProperty("last:accel") ?? accel;
        brakePower = car.getDynamicProperty("last:brake") ?? brakePower;
        traction = car.getDynamicProperty("last:traction") ?? traction;
        steerMax = car.getDynamicProperty("last:steer") ?? steerMax;
        steerMode = car.getDynamicProperty("last:steerMode") ?? 0;
    }

    const mass = defaultConfig.mass || 1200;
    const modelDir = defaultConfig.modelDirection || -1;
    const steerSens = defaultConfig.steerSensitivity || 0.2;
    const turnSpeedMult = defaultConfig.turnSpeedMultiplier || 0.8;

    const wDist = 1.2;
    const wWidth = 0.8;

    let steering = car.getProperty("megaverse:steering_angle") || 0;
    let velocity = car.getProperty("megaverse:movement_velocity") || 0;
    let gear = car.getProperty("megaverse:gear") || 0;
    let engineOn = car.getProperty("megaverse:is_engine_on") || false;
    let fuel = car.getProperty("megaverse:fuel");
    if (fuel === undefined || isNaN(fuel)) fuel = 100.0;

    // --- Phase 4: Damage state (ป้องกัน NaN ด้วย fallback เต็ม 100) ---
    let engineHealth = car.getProperty("megaverse:engine_health");
    if (engineHealth === undefined || isNaN(engineHealth)) engineHealth = 100.0;
    let suspensionHealth = car.getProperty("megaverse:suspension_health");
    if (suspensionHealth === undefined || isNaN(suspensionHealth)) suspensionHealth = 100.0;
    let bodyDamage = car.getProperty("megaverse:body_damage");
    if (bodyDamage === undefined || isNaN(bodyDamage)) bodyDamage = 0.0;

    const dim = car.dimension;
    const loc = car.location;
    let yaw = car.getRotation().y;
    if (isNaN(yaw)) yaw = 0;

    const rad = (yaw * Math.PI) / 180;
    const dirX = -Math.sin(rad) * -modelDir;
    const dirZ = Math.cos(rad) * -modelDir;

    const rightX = -dirZ;
    const rightZ = dirX;

    const flPos = { x: loc.x + (dirX * wDist) - (rightX * wWidth), y: loc.y, z: loc.z + (dirZ * wDist) - (rightZ * wWidth) };
    const frPos = { x: loc.x + (dirX * wDist) + (rightX * wWidth), y: loc.y, z: loc.z + (dirZ * wDist) + (rightZ * wWidth) };
    const rlPos = { x: loc.x - (dirX * wDist) - (rightX * wWidth), y: loc.y, z: loc.z - (dirZ * wDist) - (rightZ * wWidth) };
    const rrPos = { x: loc.x - (dirX * wDist) + (rightX * wWidth), y: loc.y, z: loc.z - (dirZ * wDist) + (rightZ * wWidth) };

    let burstFL = car.getProperty("megaverse:burst_fl") || false;
    let burstFR = car.getProperty("megaverse:burst_fr") || false;
    let burstRL = car.getProperty("megaverse:burst_rl") || false;
    let burstRR = car.getProperty("megaverse:burst_rr") || false;

    const triggerBurst = (pos, prop) => {
        car.setProperty(prop, true);
        try {
            dim.playSound("random.explode", pos, { pitch: 1.8, volume: 2.0 });
            dim.playSound("mob.enderdragon.flflap", pos, { pitch: 0.5, volume: 1.5 });
            dim.spawnParticle("minecraft:large_explosion", pos);
            dim.spawnParticle("minecraft:campfire_smoke_particle", pos);
        } catch (e) { }
    };

    // Tire-burst arrow detection: ข้ามใน tier ที่ไกล/ไม่มีคนขับ เพื่อลด raycast/entity query (Phase 6)
    if (!isReducedTier) {
        try {
            const arrows = dim.getEntities({ type: "minecraft:arrow", location: loc, maxDistance: 5 });
            for (const arrow of arrows) {
                const arrLoc = arrow.location;
                const distSq = (p1, p2) => (p1.x - p2.x) ** 2 + ((p1.y + 0.5) - p2.y) ** 2 + (p1.z - p2.z) ** 2;

                let closestDist = 3.5;
                let hitWheel = null;

                if (!burstFL) { let d = distSq(arrLoc, flPos); if (d < closestDist) { closestDist = d; hitWheel = "FL"; } }
                if (!burstFR) { let d = distSq(arrLoc, frPos); if (d < closestDist) { closestDist = d; hitWheel = "FR"; } }
                if (!burstRL) { let d = distSq(arrLoc, rlPos); if (d < closestDist) { closestDist = d; hitWheel = "RL"; } }
                if (!burstRR) { let d = distSq(arrLoc, rrPos); if (d < closestDist) { closestDist = d; hitWheel = "RR"; } }

                if (hitWheel === "FL") { burstFL = true; triggerBurst(flPos, "megaverse:burst_fl"); arrow.remove(); }
                else if (hitWheel === "FR") { burstFR = true; triggerBurst(frPos, "megaverse:burst_fr"); arrow.remove(); }
                else if (hitWheel === "RL") { burstRL = true; triggerBurst(rlPos, "megaverse:burst_rl"); arrow.remove(); }
                else if (hitWheel === "RR") { burstRR = true; triggerBurst(rrPos, "megaverse:burst_rr"); arrow.remove(); }
            }
        } catch (e) { }
    }

    let burstCount = (burstFL ? 1 : 0) + (burstFR ? 1 : 0) + (burstRL ? 1 : 0) + (burstRR ? 1 : 0);
    let pullSteer = 0;
    if (burstCount > 0) {
        if (burstFL) pullSteer -= 10.0;
        if (burstRL) pullSteer -= 5.0;
        if (burstFR) pullSteer += 10.0;
        if (burstRR) pullSteer += 5.0;
    }

    // 🌟 ยางแตกฝั่งไหน น้ำหนัก/ตัวถังเอียงไปฝั่งนั้น (ตามที่ขอ)
    // 🔧 v2.4.0: สลับเครื่องหมายจากเดิม — ผู้ใช้ทดสอบแล้วแจ้งว่าเอียงผิดฝั่ง
    let burstRollBias = 0;
    if (burstFL) burstRollBias += 3.5;
    if (burstRL) burstRollBias += 3.5;
    if (burstFR) burstRollBias -= 3.5;
    if (burstRR) burstRollBias -= 3.5;

    // 🌟 ยางแตกครบ 4 ล้อ = ขับไม่ได้อีกต่อไป (บังคับ activeMaxSpeed ลงมาแทบ 0 ด้านล่าง)
    const isImmobilized = burstCount >= 4;

    // --- เครื่องยนต์เสียหายหนัก (engineHealth <= 0) จะสตาร์ทไม่ติด (Phase 4) ---
    if (driver) {
        if (!engineOn && fuel > 0 && input.y > 0 && engineHealth > 0 && !isImmobilized) {
            engineOn = true;
            car.runCommand("playsound random.anvil_land @a ~ ~ ~ 1 2.0");
        }
    } else { engineOn = false; }

    if (engineOn) {
        fuel -= 0.005;
        if (fuel <= 0 || engineHealth <= 0 || isImmobilized) { fuel = Math.max(0, fuel); engineOn = false; }
    }
    car.setProperty("megaverse:is_engine_on", engineOn);
    car.setProperty("megaverse:fuel", Math.max(0, fuel));

    // --- Phase 3: Terrain grip แยก accel/brake/corner แทนตัวคูณเดียว ---
    let terrainGrip = { accel: 1.0, brake: 1.0, corner: 1.0, rollingResistance: 0.0 };
    try {
        const centerHit = dim.getBlockFromRay({ x: loc.x, y: loc.y + 0.5, z: loc.z }, { x: 0, y: -1, z: 0 }, { maxDistance: 1.5 });
        if (centerHit && centerHit.block) {
            terrainGrip = getTerrainGrip(centerHit.block.typeId);
        }
    } catch (e) { }

    // Handbrake: ลด rear/corner grip ลงเพื่อให้ท้ายปัดง่ายขึ้น (Phase 3)
    const cornerGripMultiplier = isHandbrake
        ? terrainGrip.corner * (defaultConfig.handbrakeRearGripMultiplier ?? 0.35)
        : terrainGrip.corner;

    let frictionMultiplier = traction * cornerGripMultiplier;
    let activeMaxSpeed = isImmobilized ? 0.0 : (maxSpeed * terrainGrip.accel) * (1.0 - (burstCount * 0.15));
    // Damage: engine ที่เสียหายให้แรงม้าลดลงตามสัดส่วน (Phase 4)
    activeMaxSpeed *= Math.max(0.4, engineHealth / 100);
    frictionMultiplier *= (1.0 - (burstCount * 0.15));

    const getRaycastHeight = (pos) => {
        const startLoc = { x: pos.x, y: loc.y + 1.2, z: pos.z };
        try {
            const hit = dim.getBlockFromRay(startLoc, { x: 0, y: -1, z: 0 }, { maxDistance: 12.0 });
            if (hit && hit.block && !hit.block.isAir) {
                let blockY = hit.block.location.y;
                if (blockY > loc.y + 1.0) return loc.y;
                const bId = hit.block.typeId;
                if (bId.includes("slab")) {
                    // 🔧 แก้บั๊กรถจมบล็อกตอนข้าม top slab: เดิมสมมติว่า slab เป็นครึ่งล่างเสมอ (+0.5)
                    // แต่ slab มี state "minecraft:vertical_half" เป็น "top" ได้ ซึ่งพื้นผิวจริงอยู่ที่ +1.0 ไม่ใช่ +0.5
                    let half = "bottom";
                    try { half = hit.block.permutation.getState("minecraft:vertical_half") ?? "bottom"; } catch (e) { }
                    return half === "top" ? blockY + 1.0 : blockY + 0.5;
                }
                if (bId.includes("stairs")) {
                    // stairs มี state "upside_down_bit" — ถ้าหงายกลับด้าน พื้นผิวจริงจะอยู่ที่ +1.0 ไม่ใช่ +0.5
                    // (ยังเป็นการประมาณด้วยความสูงเดียว ไม่ใช่รูปทรงขั้นบันไดจริง — ข้อจำกัดที่ทราบอยู่แล้ว)
                    let upsideDown = false;
                    try { upsideDown = hit.block.permutation.getState("upside_down_bit") ?? false; } catch (e) { }
                    return upsideDown ? blockY + 1.0 : blockY + 0.5;
                }
                return blockY + 1.0;
            }
        } catch (e) { }
        return loc.y - 10.0;
    };

    // Suspension 4 จุด: ใน tier ไกล/ว่าง ใช้จุดกลางคันแทนเพื่อลด raycast จาก 4 เหลือ 1 (Phase 6)
    let hFL, hFR, hRL, hRR;
    if (isReducedTier) {
        const hCenter = getRaycastHeight({ x: loc.x, y: loc.y, z: loc.z });
        hFL = hFR = hRL = hRR = hCenter;
    } else {
        hFL = getRaycastHeight(flPos);
        hFR = getRaycastHeight(frPos);
        hRL = getRaycastHeight(rlPos);
        hRR = getRaycastHeight(rrPos);
    }

    const frontHeight = (hFL + hFR) / 2.0;
    const rearHeight = (hRL + hRR) / 2.0;
    const leftHeight = (hFL + hRL) / 2.0;
    const rightHeight = (hFR + hRR) / 2.0;
    const midGroundY = (hFL + hFR + hRL + hRR) / 4.0;
    const isInAir = (loc.y - midGroundY) > 1.2;

    let targetBodyHeight = 0;
    if (!isInAir) targetBodyHeight = Math.max(-0.6, midGroundY - loc.y);

    let currentBodyHeight = car.getProperty("megaverse:body_height") || 0;
    if (isNaN(currentBodyHeight)) currentBodyHeight = 0;
    // Suspension ที่เสียหาย (Phase 4) ตอบสนองช้าลงเล็กน้อย เหมือนช็อคอัพพัง
    const suspensionResponse = 0.25 * Math.max(0.5, suspensionHealth / 100);
    currentBodyHeight += (targetBodyHeight - currentBodyHeight) * suspensionResponse;

    let isCollidingFront = false;
    let isCollidingBack = false;
    let collisionImpactSpeed = 0;

    if (!isReducedTier && Math.abs(velocity) > 0.05 && !isInAir && state.terrainPitch < 15.0) {
        const lookDist = Math.max(1.0, Math.abs(velocity) * 1.2);
        const moveDirX = velocity >= 0 ? dirX : -dirX;
        const moveDirZ = velocity >= 0 ? dirZ : -dirZ;

        try {
            const hitBlock = dim.getBlockFromRay({ x: loc.x, y: loc.y + 1.5, z: loc.z }, { x: moveDirX, y: 0, z: moveDirZ }, { maxDistance: lookDist });
            if (hitBlock && hitBlock.block && !hitBlock.block.isAir && !hitBlock.block.typeId.includes("grass")) {
                let bId = hitBlock.block.typeId;
                if (!bId.includes("stairs") && !bId.includes("slab")) {
                    collisionImpactSpeed = Math.abs(velocity);
                    if (velocity >= 0) isCollidingFront = true;
                    else isCollidingBack = true;
                    velocity = (velocity > 0) ? -0.1 : 0.1;
                    state.terrainPitch = 0;
                    state.weightTransfer = 0;
                }
            }
        } catch (e) { }
    }

    // --- Phase 4: Collision damage — เฉพาะชนแรง ๆ เท่านั้นถึงจะเสียหาย ---
    if (collisionImpactSpeed > 0.3) {
        const dmg = Math.min(35, (collisionImpactSpeed - 0.3) * (defaultConfig.collisionDamagePerSpeed ?? 18));
        bodyDamage = Math.min(100, bodyDamage + dmg);
        engineHealth = Math.max(0, engineHealth - dmg * 0.4);
        suspensionHealth = Math.max(0, suspensionHealth - dmg * 0.3);
        try {
            dim.playSound("mob.irongolem.hit", loc, { pitch: 0.7, volume: 2.0 });
        } catch (e) { }
    }

    let speedRatio = Math.abs(velocity) / activeMaxSpeed;
    if (isNaN(speedRatio)) speedRatio = 0;
    let safeSpeedRatio = Math.min(speedRatio, 1.0);

    // --- Phase 2: Engine / Transmission (RPM, gear, torque curve, engine braking) ---
    const engineResult = updateEngineTransmission({
        gear,
        velocity,
        activeMaxSpeed,
        throttleInput: input.y,
        config: defaultConfig,
        shiftTimer: state.shiftTimer
    });
    let rpm = engineResult.rpm;
    let torqueMult = engineResult.torqueMult;
    const engineBrakeForce = engineResult.engineBrakeForce;
    // engine health ที่ต่ำลดแรงบิดเพิ่มอีกชั้น (นอกเหนือจาก activeMaxSpeed ที่ลดไปแล้ว)
    torqueMult *= Math.max(0.5, engineHealth / 100);

    // 🔧 แก้บั๊กเกียร์ค้าง: เดิม shiftTimer ถูกลดค่าเฉพาะตอนกดคันเร่งอยู่เท่านั้น (อยู่ในบล็อกเร่งความเร็ว)
    // ถ้าผู้เล่นถอนคันเร่ง/เบรก/ล่องลอยระหว่างช่วง shift delay ตัวนับจะค้างไม่ลดลง ทำให้ห้ามเปลี่ยนเกียร์ถาวร
    // ย้ายมานับถอยหลังที่นี่ที่เดียว ไม่ขึ้นกับ input เพื่อให้ shift delay จบตรงเวลาเสมอ
    if (state.shiftTimer > 0) state.shiftTimer--;

    // --- Phase 5: เสียงเครื่องยนต์อิง RPM แทน speed ล้วน ---
    if (engineOn) {
        state.soundTimer++;
        if (state.soundTimer >= 1) {
            state.soundTimer = 0;
            const rpmRatio = Math.max(0, Math.min(1, (rpm - defaultConfig.idleRPM) / (defaultConfig.redlineRPM - defaultConfig.idleRPM)));
            let enginePitch = 0.75 + (rpmRatio * 1.15);
            // เครื่องยนต์เสียหายมาก -> เสียงสั่น/เพี้ยนเล็กน้อย
            if (engineHealth < 40) enginePitch += (Math.random() - 0.5) * 0.15;
            try {
                if (driver && driver.typeId === "minecraft:player") {
                    driver.playSound("custom.car.engine_drive", { pitch: enginePitch, volume: 1.5 });
                    car.runCommand(`playsound custom.car.engine_drive @a[rm=1] ~ ~ ~ 2.0 ${enginePitch.toFixed(2)}`);
                } else {
                    dim.playSound("custom.car.engine_drive", loc, { pitch: enginePitch, volume: 2.0 });
                }
            } catch (e) { }
        }
    } else {
        state.soundTimer = 0;
    }

    let isDrifting = car.hasTag("is_drifting");

    const cV = car.getVelocity();
    let targetVy = cV ? (isNaN(cV.y) ? 0 : cV.y) : 0;
    let speedKmh = Math.min(Math.abs(velocity) * 72.0, 1500.0);

    const isFrontHanging = (loc.y - frontHeight) > 1.2;
    const isRearHanging = (loc.y - rearHeight) > 1.2;

    if (isInAir) {
        if (!state.wasInAir) {
            if (state.terrainPitch > 2.0 && Math.abs(velocity) > 0.15) {
                let pitchRad = state.terrainPitch * (Math.PI / 180);
                let safeLaunchVel = Math.min(Math.abs(velocity), activeMaxSpeed * 1.5);
                let launchForce = safeLaunchVel * 3.5;
                let liftY = Math.sin(pitchRad) * launchForce;
                let forwardX = Math.cos(pitchRad) * Math.abs(velocity);

                targetVy = Math.max(targetVy, liftY);
                velocity = Math.sign(velocity) * forwardX;

                targetVy = Math.max(-50.0, Math.min(50.0, targetVy));
                velocity = Math.max(-50.0, Math.min(50.0, velocity));
            }
            state.wasInAir = true;
        }

        targetVy -= 0.035;
        velocity *= 0.995;

        let targetAirPitch = 0;
        if (targetVy > 0) targetAirPitch = state.terrainPitch;
        else targetAirPitch = -15.0;

        if (input.y > 0) targetAirPitch += 15.0;
        else if (input.y < 0) targetAirPitch -= 20.0;

        state.terrainPitch += (targetAirPitch - state.terrainPitch) * 0.08;
        state.terrainRoll += ((input.x * 25.0) - state.terrainRoll) * 0.1;
        steering = (state.terrainRoll / 25.0) * steerMax * 0.5;

        state.weightTransfer += (0 - state.weightTransfer) * 0.1;

    } else {
        state.wasInAir = false;

        if (Math.abs(velocity) > 0.05) {
            let leadingHeight = (velocity > 0) ? frontHeight : rearHeight;
            let stepDiff = leadingHeight - loc.y;

            if (stepDiff > 0.25 && stepDiff <= 1.2) {
                let liftForce = (stepDiff > 0.6) ? 0.52 : 0.38;
                targetVy = Math.max(targetVy, liftForce);
                if (Math.abs(velocity) < activeMaxSpeed * 0.9) {
                    velocity *= 1.02;
                }
            }
        }

        let steeringReduction = Math.max(0.25, 1.0 - (safeSpeedRatio * 0.75));
        let targetSteering = 0;

        if (steerMode === 1 && driver) {
            let driverYaw = driver.getRotation().y;
            let yawDiff = driverYaw - yaw;
            while (yawDiff > 180) yawDiff -= 360;
            while (yawDiff < -180) yawDiff += 360;
            let rawSteer = Math.max(-steerMax, Math.min(steerMax, yawDiff));
            targetSteering = rawSteer * steeringReduction;
        } else {
            targetSteering = -input.x * steerMax * steeringReduction;
        }

        targetSteering += (pullSteer * safeSpeedRatio) * 0.2;

        // Handbrake: อนุญาตให้ steering หมุนไวขึ้นตอนดึงมือเบรก (ท้ายปัด) — Phase 3
        let sensitivityReduction = Math.max(0.2, 1.0 - (safeSpeedRatio * 0.8));
        if (isHandbrake) sensitivityReduction = Math.min(1.0, sensitivityReduction * 1.6);
        const activeSensitivity = steerSens * frictionMultiplier * sensitivityReduction;

        if (engineOn || Math.abs(velocity) > 0.1) {
            if (Math.abs(targetSteering) > 0.1) steering += (targetSteering - steering) * activeSensitivity;
            else if (Math.abs(velocity) > 0.05) steering += (0 - steering) * 0.15;
        }

        // Drift: handbrake ช่วยให้เข้าสภาวะ drift ได้ง่ายขึ้น ไม่ต้องพึ่งความเร็ว+เบรกเท้าอย่างเดียว (Phase 3)
        if ((safeSpeedRatio > 0.5 && isBraking && Math.abs(input.x) > 0.5) ||
            (isHandbrake && safeSpeedRatio > 0.25 && Math.abs(input.x) > 0.3)) {
            if (!isDrifting) car.addTag("is_drifting");
            isDrifting = true;
        } else if (safeSpeedRatio < 0.2 || Math.abs(input.x) < 0.1) {
            if (isDrifting) car.removeTag("is_drifting");
            isDrifting = false;
        }

        if (!isCollidingFront && !isCollidingBack) {
            if (!isFrontHanging && !isRearHanging) {
                const heightDiff = frontHeight - rearHeight;
                const clampedHeightDiff = Math.max(-3.5, Math.min(3.5, heightDiff));
                let slopeTargetPitch = -Math.atan2(clampedHeightDiff, wDist * 2.0) * (180 / Math.PI) * modelDir;
                state.terrainPitch += (slopeTargetPitch - state.terrainPitch) * 0.25;
            }
        }

        if (!isFrontHanging && !isRearHanging) {
            const rollDiff = rightHeight - leftHeight;
            const clampedRollDiff = Math.max(-1.5, Math.min(1.5, rollDiff));
            let slopeTargetRoll = -Math.atan2(clampedRollDiff, wWidth * 2.0) * (180 / Math.PI) * modelDir;
            let steeringRoll = -(steering / steerMax) * 8.0 * safeSpeedRatio;
            state.terrainRoll += ((slopeTargetRoll + steeringRoll) - state.terrainRoll) * 0.25;
        } else {
            state.terrainRoll += (0 - state.terrainRoll) * 0.15;
        }

        let targetWT = 0;
        if (isBraking || isHandbrake) {
            targetWT = 1.2 * modelDir;
            let finalBrake = brakePower * traction * terrainGrip.brake;
            if (isDrifting) finalBrake *= 0.3;
            if (isHandbrake) finalBrake *= 0.5; // มือเบรกไม่ใช่เบรกเต็มแรงเหมือนเบรกเท้า
            if (velocity > 0) velocity = Math.max(0, velocity - finalBrake);
            else if (velocity < 0) velocity = Math.min(0, velocity + finalBrake);
        } else if (input.y > 0 && engineOn && !isCollidingFront) {
            targetWT = -0.8 * modelDir;
            let massFactor = 1000 / mass;
            let dynamicAccel = accel * massFactor * torqueMult * Math.max(0.15, 1.0 - Math.pow(safeSpeedRatio, 1.5));
            if (state.shiftTimer > 0) {
                dynamicAccel *= 0.1;
            }
            velocity += (activeMaxSpeed - velocity) * dynamicAccel;
        } else if (input.y < 0 && engineOn && !isCollidingBack) {
            targetWT = -0.6 * modelDir;
            let massFactor = 1000 / mass;
            let dynamicAccel = (accel * 0.6) * massFactor * Math.max(0.2, 1.0 - safeSpeedRatio);
            velocity -= dynamicAccel;
        } else {
            let slopeFactor = Math.min(1.0, Math.abs(state.terrainPitch) / 35.0);
            let glideFriction = 0.94 + (slopeFactor * 0.05) - terrainGrip.rollingResistance;
            // Phase 2: engine braking — เข้าเกียร์อยู่แต่ถอนคันเร่ง ให้หน่วงเพิ่มจากเดิม (แทนการไถลเฉย ๆ)
            if (engineOn && gear !== 0) velocity -= Math.sign(velocity) * engineBrakeForce;
            velocity *= Math.max(0.85, glideFriction);
            if (state.terrainPitch < -5.0) targetWT = -2.0 * modelDir;
            else if (state.terrainPitch > 5.0) targetWT = 2.0 * modelDir;
        }
        state.weightTransfer += (targetWT - state.weightTransfer) * 0.1;
        let slopeForce = Math.sin((state.terrainPitch * Math.PI) / 180) * 0.022 * modelDir;
        if (input.y > 0 && slopeForce < 0) slopeForce *= 0.1;
        velocity += slopeForce;
    }

    let currentPitch = state.terrainPitch + state.weightTransfer;
    let currentRoll = state.terrainRoll + burstRollBias;
    // Suspension เสียหายหนัก: เพิ่ม jitter เล็กน้อยให้รู้สึกว่ารถโยกผิดปกติ (Phase 4)
    if (suspensionHealth < 40 && Math.abs(velocity) > 0.1) {
        currentRoll += (Math.random() - 0.5) * (1.0 - suspensionHealth / 40) * 2.0;
    }

    const prevGear = car.getProperty("megaverse:gear") || 0;
    gear = engineResult.gear;
    if (gear !== prevGear && Math.abs(gear) >= 1) {
        state.shiftTimer = defaultConfig.shiftDelayTicks ?? 6;
        try {
            car.runCommand(`playsound custom.car.gear_shift @a ~ ~ ~ 1 1.0`);
        } catch (e) { }
    }

    car.setProperty("megaverse:gear", gear);
    car.setProperty("megaverse:movement_velocity", velocity);
    car.setProperty("megaverse:body_pitch", currentPitch);
    car.setProperty("megaverse:steering_angle", steering);
    car.setProperty("megaverse:body_roll", currentRoll);
    car.setProperty("megaverse:body_height", currentBodyHeight);
    car.setProperty("megaverse:speed_kmh", speedKmh);
    car.setProperty("megaverse:rpm", rpm);
    car.setProperty("megaverse:engine_health", engineHealth);
    car.setProperty("megaverse:suspension_health", suspensionHealth);
    car.setProperty("megaverse:body_damage", bodyDamage);

    if (driver) {
        // 🔧 v2.4.0: แยก try/catch เป็นก้อนย่อยแทนก้อนเดียวใหญ่ — เดิมถ้า driver.setProperty()
        // สำหรับ body_height/pitch/roll throw error (เช่นถ้า minecraft:player ไม่มี custom property
        // เหล่านี้ประกาศไว้ในไฟล์ behavior ของ player ซึ่งไม่ได้อยู่ใน Car-Only Extract นี้)
        // จะทำให้ทุกอย่างหลังจากนั้นในบล็อกเดียวกัน "ไม่ทำงานเลย" รวมถึง ActionBar ด้วย
        // (นี่คือสาเหตุจริงที่ ActionBar ไม่เคยขึ้นเลยแม้จะเพิ่งเพิ่มไปในเวอร์ชันก่อน)
        try {
            driver.setProperty("megaverse:body_height", currentBodyHeight);
            driver.setProperty("megaverse:body_pitch", currentPitch);
            driver.setProperty("megaverse:body_roll", currentRoll);
        } catch (e) { }

        let numFL = burstFL ? 0 : 1;
        let numFR = burstFR ? 0 : 1;
        let numRL = burstRL ? 0 : 1;
        let numRR = burstRR ? 0 : 1;

        // ใช้ velocity ล่าสุด (หลังคำนวณ accel/brake ของ tick นี้เสร็จแล้ว) กันตัวเลขค้างช้าไป 1 tick
        let liveSpeedKmh = Math.min(Math.abs(velocity) * 72.0, 1500.0);
        let f_speed = Math.floor(engineOn ? liveSpeedKmh : 0);
        let f_gear = Math.floor(gear || 0);

        // เก็บ car_hud_string ไว้ให้ dashboard panel แบบ JSON UI (ตัวหลักที่ใช้งานจริง — ยืนยันแล้วว่าติดตั้งได้และแสดงผล)
        try {
            if (engineOn) {
                driver.setDynamicProperty("car_hud_string", `car:${f_speed} ${f_gear} ${numFL} ${numFR} ${numRL} ${numRR} `);
            } else {
                driver.setDynamicProperty("car_hud_string", `car:0 0 ${numFL} ${numFR} ${numRL} ${numRR} `);
            }
        } catch (e) { }

        // 🔧 v2.5.0: ปิด ActionBar ออกตามคำขอ — ซ้อนทับกับ JSON UI dashboard ที่ใช้งานได้แล้วจริง
        // (เก็บโค้ดไว้เป็นคอมเมนต์เผื่อในอนาคตอยากสลับกลับมาใช้)
        // try {
        //     let gearLabel = gear < 0 ? "R" : (gear === 0 ? "N" : String(Math.floor(gear)));
        //     const tireIcon = (burst) => burst ? "§c✕§r" : "§a●§r";
        //     let actionBarText = `§e${f_speed} km/h §7| §bเกียร์ ${gearLabel} §7| §f🛞${tireIcon(burstFL)}${tireIcon(burstFR)} ${tireIcon(burstRL)}${tireIcon(burstRR)}`;
        //     if (isImmobilized) actionBarText += " §c(ยางแตกหมด - ขับไม่ได้)";
        //     driver.onScreenDisplay.setActionBar(actionBarText);
        // } catch (e) { }

        try {
            driver.addTag("driving_ui");
            driver.setDynamicProperty("ui_tick", 0);
        } catch (e) { }
    }

    let targetVx = dirX * velocity;
    let targetVz = dirZ * velocity;
    let finalImpulseX = targetVx - (cV ? (isNaN(cV.x) ? 0 : cV.x) : 0);
    let finalImpulseY = targetVy - (cV ? (isNaN(cV.y) ? 0 : cV.y) : 0);
    let finalImpulseZ = targetVz - (cV ? (isNaN(cV.z) ? 0 : cV.z) : 0);

    car.applyImpulse({ x: finalImpulseX, y: finalImpulseY, z: finalImpulseZ });

    if (Math.abs(velocity) > 0.01 || isInAir) {
        let activeTurnMult = turnSpeedMult;
        if (isDrifting) activeTurnMult *= 0.8;
        let absVel = Math.abs(velocity);
        let turnSpeedLimit = isInAir ? 0.3 : 1.2;
        let rotationVelocity = Math.sign(velocity) * Math.min(absVel, turnSpeedLimit);
        let targetYaw = yaw + (steering * rotationVelocity * activeTurnMult);
        car.setRotation({ x: -currentPitch, y: targetYaw });
    }

    let wheelRot = (car.getProperty("megaverse:wheels_rotation") || 0) - (velocity * 120.0);
    car.setProperty("megaverse:wheels_rotation", (wheelRot % 360));
}
