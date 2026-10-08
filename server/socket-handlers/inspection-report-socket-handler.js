const { checkLogin } = require("../util-server");
const { InspectionReportService } = require("../inspection-report-service");
const { inspectionReportScheduler } = require("../inspection-report-scheduler");

/**
 * Register inspection report socket use cases.
 * @param {Socket} socket Socket.io socket
 * @returns {void}
 */
function inspectionReportSocketHandler(socket) {
    socket.on("getInspectionReportSettings", async (callback) => {
        try {
            checkLogin(socket);
            callback({ ok: true, settings: await inspectionReportScheduler.getSettings(socket.userID) });
        } catch (error) {
            callback({ ok: false, msg: "Unable to load inspection settings." });
        }
    });

    socket.on("setInspectionReportSettings", async (settings, callback) => {
        try {
            checkLogin(socket);
            callback({ ok: true, settings: await inspectionReportScheduler.saveSettings(socket.userID, settings) });
        } catch (error) {
            callback({ ok: false, msg: error.message.startsWith("Invalid inspection") ? error.message : "Unable to save inspection settings." });
        }
    });

    socket.on("getInspectionReportAvailability", async (callback) => {
        try {
            checkLogin(socket);
            callback({
                ok: true,
                recipientCount: await InspectionReportService.getEligibleRecipientCount(socket.userID),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("sendInspectionReport", async (callback) => {
        try {
            checkLogin(socket);
            callback({
                ok: true,
                result: await InspectionReportService.sendManual(socket.userID),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });
}

module.exports = {
    inspectionReportSocketHandler,
};
