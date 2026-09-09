// ==========================================
// 🚗 car_hud.js — Car HUD title-refresh loop (เดิมชื่อ hud_system.js)
//
// ไฟล์นี้มีหน้าที่เดียว: รีเฟรช title (ที่ใช้เป็นช่องส่งข้อมูลให้ dashboard panel ใน hud_screen.json)
// และจัดการวงจรชีวิตของ car_hud_string / ui_tick / driving_ui tag
//
// หมายเหตุ: fadeInDuration/fadeOutDuration ตั้งเป็น 0 เพื่อให้ title อัปเดตทันทีทุกครั้งไม่มีดีเลย์แอนิเมชัน
// ==========================================
import { world, system } from "@minecraft/server";

const INSTANT_TITLE_OPTIONS = { fadeInDuration: 0, stayDuration: 10, fadeOutDuration: 0 };

system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        try { const checkLoc = player.location; } catch (e) { continue; }

        // จุดเดียวที่จัดการวงจรชีวิตของ car HUD (ui_tick + driving_ui tag)
        let uiTick = player.getDynamicProperty("ui_tick");
        if (uiTick === undefined) uiTick = 100;

        if (uiTick > 5) {
            if (player.hasTag("driving_ui")) {
                player.setDynamicProperty("car_hud_string", "car:off ");
                player.removeTag("driving_ui");
            }
        } else {
            player.setDynamicProperty("ui_tick", uiTick + 1);
        }

        let carStr = player.getDynamicProperty("car_hud_string") || "car:off ";
        try {
            player.onScreenDisplay.setTitle(carStr, INSTANT_TITLE_OPTIONS);
        } catch (e) { }
    }
}, 2);
