const cron = require("node-cron");
const InvoiceModel = require("../models/invoice-model");

// Toshkent bo'yicha vaqt olish
function getTashkentDate() {
    return new Date(
        new Date().toLocaleString("en-US", { timeZone: "Asia/Tashkent" })
    );
}

cron.schedule("*/1 * * * *", async () => {
    try {
        const io = global.io;

        const now = getTashkentDate();

        const year = now.getFullYear();
        const month = now.getMonth();
        const day = now.getDate();
        const hour = now.getHours();   // Toshkent soati

        const hourStart = new Date(year, month, day, hour, 0, 0);
        const hourEnd   = new Date(year, month, day, hour + 1, 0, 0);

        // 🔥 LOG - Toshkent vaqtida ko‘rsatadi
        console.log(
            "⏳ Checking invoices for:",
            hourStart.toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" }),
            "→",
            hourEnd.toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" })
        );

        const invoices = await InvoiceModel.find({
            newDueDate: {
                $gte: hourStart,
                $lt: hourEnd
            },
            notificationSent: false
        });

        if (!invoices.length) {
            console.log("⚪ No pending invoices for this time window.");
            return;
        }

        for (const inv of invoices) {
            io.emit("invoice:newDueDateNotification", {
                DocEntry: inv.DocEntry,
                InstlmntID: inv.InstlmntID,
                newDueDate: inv.newDueDate,
                CardCode: inv.CardCode
            });

            inv.notificationSent = true;
            await inv.save();
        }

        console.log("🟢 Notifications sent.");
    } catch (err) {
        console.error("❌ Cron job error:", err);
    }
});
