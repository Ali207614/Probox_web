const cron = require("node-cron");
const InvoiceModel = require("../models/invoice-model");

cron.schedule("*/1 * * * *", async () => {
    try {
        const io = global.io;

        const now = new Date();

        const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0);
        const hourEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0);

        console.log("⏳ Checking invoices for:", hourStart.toISOString(), "→", hourEnd.toISOString());

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

        console.log(`🔵 ${invoices.length} invoices matched for this hour`);

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

        console.log("🟢 Notifications sent & updated.");
    } catch (err) {
        console.error("❌ Cron job error:", err);
    }
});
