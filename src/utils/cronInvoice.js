const cron = require("node-cron");
const InvoiceModel = require("../models/invoice-model");
const moment = require('moment-timezone');

cron.schedule("0 * * * *", async () => {
    try {
        const io = global.io;

        const start = moment().tz("Asia/Tashkent").startOf("hour");
        const end   = moment(start).add(1, "hour");

        const invoices = await InvoiceModel.find({
            newDueDate: {
                $gte: start.toDate(),
                $lt: end.toDate()
            },
            notificationSent: false
        });

        console.log("Searching between:", start.format(), "→", end.format());

        if (!invoices.length) {
            console.log("⚪ No invoices for this hour");
            return;
        }

        io.emit("invoice:newDueDateNotification", invoices);

        await Promise.all(
            invoices.map(inv => {
                inv.notificationSent = true;
                return inv.save();
            })
        );

        console.log("🟢 Notifications sent.");
    } catch (err) {
        console.error("❌ Cron job error:", err);
    }
});

