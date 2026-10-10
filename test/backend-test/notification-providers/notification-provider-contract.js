const assert = require("node:assert/strict");
const { DOWN, UP } = require("../../../src/util");

const MONITOR = { name: "契约监控项" };
const SCENARIOS = [
    {
        mode: "general",
        marker: "contract-general",
        send: (provider, notification, marker) => provider.send(notification, marker),
    },
    {
        mode: "certificate",
        marker: "contract-certificate-expiry",
        send: (provider, notification, marker) => provider.send(notification, marker),
    },
    {
        mode: "down",
        marker: "contract-down",
        send: (provider, notification, marker) => provider.send(notification, marker, MONITOR, {
            status: DOWN,
            msg: marker,
            ping: 120,
            time: "2026-10-09 16:00:00",
            localDateTime: "2026-10-09 09:00:00",
            timezone: "America/Los_Angeles",
        }),
    },
    {
        mode: "recovery",
        marker: "contract-recovery",
        send: (provider, notification, marker) => provider.send(notification, marker, MONITOR, {
            status: UP,
            time: "2026-10-09 16:05:00",
            lastDownTime: "2026-10-09 16:00:00",
            localDateTime: "2026-10-09 09:05:00",
            timezone: "America/Los_Angeles",
        }),
    },
    {
        mode: "inspection",
        marker: "contract-inspection",
        send: (provider, notification, marker, report) => provider.sendInspectionReport(notification, report),
    },
];

/**
 * Exercise the public provider methods for every supported notification mode.
 * Providers keep their own payload formats; the adapter only asserts observable delivery.
 * @param {object} contract Provider-specific adapter
 * @returns {Promise<void>} Resolves after every mode has delivered exactly once
 */
async function exerciseNotificationProviderContract(contract) {
    const {
        name,
        provider,
        notification,
        deliveries,
        report,
        assertDelivery,
    } = contract;

    for (const scenario of SCENARIOS) {
        const beforeCount = deliveries.length;
        const result = await scenario.send(provider, notification, scenario.marker, report);
        assert.equal(result, "Sent Successfully.", `${name} ${scenario.mode} should report acceptance`);
        assert.equal(deliveries.length, beforeCount + 1, `${name} ${scenario.mode} should deliver exactly once`);
        await assertDelivery(scenario.mode, deliveries.at(-1), scenario.marker);
    }
}

module.exports = { exerciseNotificationProviderContract };
