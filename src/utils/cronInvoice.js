const cron = require("node-cron");
const InvoiceModel = require("../models/invoice-model");

cron.schedule("2 * * * *", async () => {
    try {
        const io = global.io;

        const now = new Date();
        const hour = now.toISOString().substring(11, 13) + ":00";

        console.log("⏳ Checking invoices for:", hour);

        const invoices = await InvoiceModel.find({
            newTime: hour,
            notificationSent: false
        });

        if (!invoices.length) {
            console.log("⚪ No pending invoices for this hour.");
            return;
        }

        console.log(`🔵 ${invoices.length} invoices found for ${hour}`);

        for (const inv of invoices) {
            io.emit("invoice:newTimeNotification", {
                DocEntry: inv.DocEntry,
                InstlmntID: inv.InstlmntID,
                newDueDate: inv.newDueDate,
                newTime: inv.newTime,
                CardCode: inv.CardCode
            });

            inv.notificationSent = true;
            await inv.save();
        }

        console.log("🟢 Notifications sent and marked.");
    } catch (err) {
        console.error("❌ Cron job error:", err);
    }
});
