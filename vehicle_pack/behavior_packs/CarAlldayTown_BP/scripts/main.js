// ==========================================
// 🚗 Car AllDay Town — Main Entry Point
// v3.0.0 — จัดระเบียบโปรเจกต์ใหม่ทั้งหมด: ตัด import ระบบอื่นที่ไม่เกี่ยวกับรถออก
// (config.js/core/database.js/core/player_init.js/core/admin_bridge.js/modules/atm.js/
//  modules/backpack.js/modules/phone.js/modules/auth.js/modules/proximity.js — ทั้งหมดนี้
//  เป็นของระบบเซิร์ฟเวอร์อื่นที่ไม่เกี่ยวกับรถ ถูกลบออกจากแอดออนนี้แล้วตามคำขอ
//  "ทำให้ไฟล์เป็นแอดออนรถอย่างเดียว")
// ==========================================
import { world, system } from "@minecraft/server";

import "./modules/car_hud.js";
import { updateCarPhysics } from "./modules/car_physics.js";

const ADDON_NAME = "Car AllDay Town";

system.run(() => {
    console.warn(`[System] ${ADDON_NAME} is running successfully!`);
});

// ==========================================
// 🚙 BEDROCK-RP INTEGRATION (vehicle_pack)
// ==========================================
// The original addon's "tune car with a compass" form and the "audio tuning"
// stick debug tool were removed on purpose: the compass is reserved by the
// server's RP inventory trigger, and the server-side vehicle system owns all
// vehicle state (fuel/lock/sale), so tuning belongs in the server's `!car`
// system, not duplicated client-side. The blocks below are the remaining
// pure-physics surface: LOD-tagged physics updates + HUD burst syncing.

// ==========================================
// 🚙 ระบบอัปเดต UI ทันทีเมื่อคลิกขวาเพื่อขึ้นรถ
// ==========================================
world.afterEvents.playerInteractWithEntity.subscribe((event) => {
    const { target: car, player } = event;
    if (car.typeId && car.typeId.includes("megaverse:")) {
        system.runTimeout(() => {
            const rideComp = player.getComponent("minecraft:riding");
            if (rideComp) {
                const burstFL = car.getProperty("megaverse:burst_fl") ? 0 : 1;
                const burstFR = car.getProperty("megaverse:burst_fr") ? 0 : 1;
                const burstRL = car.getProperty("megaverse:burst_rl") ? 0 : 1;
                const burstRR = car.getProperty("megaverse:burst_rr") ? 0 : 1;
                // ฝากข้อมูลให้ car_hud.js แทนการสั่ง setTitle ตรงๆ
                player.setDynamicProperty("car_hud_string", `car:0 0 ${burstFL} ${burstFR} ${burstRL} ${burstRR} `);
            }
        }, 1);
    }
});

// ==========================================
// 🚙 ระบบ Loop ฟิสิกส์ + Performance LOD (Phase 6)
//
// จัดระดับรถเป็น active / nearby / far / empty ตามระยะห่างจากผู้เล่นที่ใกล้ที่สุด
// แล้วอัปเดตความถี่ต่างกัน ลดภาระ raycast/entity-query เมื่อมีรถจำนวนมากพร้อมกัน (20-50 คัน)
// ==========================================
const carLODState = new Map(); // car.id -> { tier, tickCounter, reclassifyCounter }
const LOD_RECLASSIFY_INTERVAL_TICKS = 10;
const LOD_UPDATE_INTERVAL_TICKS = { active: 1, nearby: 2, far: 10, empty: 20 };
const LOD_NEARBY_RADIUS = 32;
const LOD_FAR_RADIUS = 96;

function classifyVehicleTier(car, dim) {
    try {
        const rideable = car.getComponent("rideable");
        if (rideable && rideable.getRiders().length > 0) return "active";
    } catch (e) { }
    try {
        if (dim.getPlayers({ location: car.location, maxDistance: LOD_NEARBY_RADIUS }).length > 0) return "nearby";
    } catch (e) { }
    try {
        if (dim.getPlayers({ location: car.location, maxDistance: LOD_FAR_RADIUS }).length > 0) return "far";
    } catch (e) { }
    return "empty";
}

// กันหน่วยความจำรั่วเมื่อรถถูกลบ/unload (Phase 6: cleanup)
world.afterEvents.entityRemove.subscribe((event) => {
    try { carLODState.delete(event.removedEntityId ?? event.entityId); } catch (e) { }
});

system.runInterval(() => {
    const dimensions = ["overworld", "nether", "the_end"];
    for (const dimId of dimensions) {
        try {
            const dim = world.getDimension(dimId);
            for (const car of dim.getEntities()) {
                if (!(car.typeId && car.typeId.includes("megaverse:"))) continue;

                let lod = carLODState.get(car.id);
                if (!lod) {
                    lod = { tier: "active", tickCounter: 0, reclassifyCounter: 0 };
                    carLODState.set(car.id, lod);
                }

                lod.reclassifyCounter++;
                if (lod.reclassifyCounter >= LOD_RECLASSIFY_INTERVAL_TICKS) {
                    lod.reclassifyCounter = 0;
                    try { lod.tier = classifyVehicleTier(car, dim); } catch (e) { }
                }

                lod.tickCounter++;
                const interval = LOD_UPDATE_INTERVAL_TICKS[lod.tier] ?? 1;
                if (lod.tickCounter >= interval) {
                    lod.tickCounter = 0;
                    try { updateCarPhysics(car, lod.tier); } catch (e) { }
                }
            }
        } catch (e) { }
    }
}, 0);

// (The addon's original compass "tune car" form and the stick "audio tuning"
//  debug tool were removed for the bedrock-rp integration — the compass is
//  the RP inventory trigger and the server's !car system owns all vehicle
//  state. Physics/LOD below is unchanged.)
