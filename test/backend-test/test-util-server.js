const { describe, test, mock } = require("node:test");
const assert = require("node:assert");
const ping = require("@louislam/ping");
const { pingAsync } = require("../../server/util-server");

describe("Server Utilities: pingAsync", () => {
    test("should convert IDN domains to Punycode before pinging", async () => {
        const idnDomain = "münchen.de";
        const punycodeDomain = "xn--mnchen-3ya.de";
        mock.method(ping.promise, "probe", async (hostname) => {
            assert.strictEqual(hostname, punycodeDomain);
            return { alive: true, time: 1 };
        });

        try {
            assert.strictEqual(await pingAsync(idnDomain, false, 1, "", true, 56, 1, 1), 1);
        } finally {
            mock.restoreAll();
        }
    });

    test("should strip brackets from IPv6 addresses before pinging", async () => {
        const ipv6WithBrackets = "[2606:4700:4700::1111]";
        const ipv6Raw = "2606:4700:4700::1111";

        await assert.rejects(pingAsync(ipv6WithBrackets, true, 1, "", true, 56, 1, 1), (err) => {
            assert.strictEqual(
                err.message.includes(ipv6WithBrackets),
                false,
                "Error message should not contain brackets"
            );
            // Allow either the IP in the message (local) OR "Network is unreachable"
            const containsIP = err.message.includes(ipv6Raw);
            const isUnreachable =
                err.message.includes("Network is unreachable") || err.message.includes("Network unreachable");
            // macOS error when IPv6 stack is missing
            const isMacOSError = err.message.includes("nodename nor servname provided");
            assert.ok(
                containsIP || isUnreachable || isMacOSError,
                `Ping failed correctly, but error message format was unexpected.\nGot: "${err.message}"\nExpected to contain IP "${ipv6Raw}" OR be a standard network error.`
            );
            return true;
        });
    });

    test("should handle standard ASCII domains correctly", async () => {
        const domain = "invalid-domain.test";
        await assert.rejects(pingAsync(domain, false, 1, "", true, 56, 1, 1), (err) => {
            assert.strictEqual(err.message.includes("Parameter string not correctly encoded"), false);
            assert.ok(
                err.message.includes(domain),
                `Error message should contain the domain "${domain}". Got: ${err.message}`
            );
            return true;
        });
    });
});
