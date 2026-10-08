const { checkLogin } = require("../util-server");
const { InspectionReportService } = require("../inspection-report-service");

/**
 * Register inspection report socket use cases.
 * @param {Socket} socket Socket.io socket
 * @returns {void}
 */
function inspectionReportSocketHandler(socket) {
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
