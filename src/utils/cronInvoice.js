const cron = require("node-cron");
const InvoiceModel = require("../models/invoice-model");

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
        const hour = now.getHours();

        const hourStart = new Date(year, month, day, hour, 0, 0);
        const hourEnd   = new Date(year, month, day, hour + 1, 0, 0);

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

        io.emit("invoice:newDueDateNotification", invoices);

        for (const inv of invoices ) {
            inv.notificationSent = true;
            await inv.save();
        }

        console.log("🟢 Notifications sent.");
    } catch (err) {
        console.error("❌ Cron job error:", err);
    }
});
