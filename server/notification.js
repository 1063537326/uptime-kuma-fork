const { R } = require("redbean-node");
const { log } = require("../src/util");
const Alerta = require("./notification-providers/alerta");
const AlertNow = require("./notification-providers/alertnow");
const AliyunSms = require("./notification-providers/aliyun-sms");
const Apprise = require("./notification-providers/apprise");
const Bale = require("./notification-providers/bale");
const Bark = require("./notification-providers/bark");
const BearSMS = require("./notification-providers/bearsms");
const Bitrix24 = require("./notification-providers/bitrix24");
const ClickUp = require("./notification-providers/clickup");
const ClickSendSMS = require("./notification-providers/clicksendsms");
const CallMeBot = require("./notification-providers/call-me-bot");
const SMSC = require("./notification-providers/smsc");
const DingDing = require("./notification-providers/dingding");
const Discord = require("./notification-providers/discord");
const Fluxer = require("./notification-providers/fluxer");
const Elks = require("./notification-providers/46elks");
const EgoSMS = require("./notification-providers/egosms");
const Feishu = require("./notification-providers/feishu");
const Notifery = require("./notification-providers/notifery");
const FreeMobile = require("./notification-providers/freemobile");
const GoogleChat = require("./notification-providers/google-chat");
const GoogleSheets = require("./notification-providers/google-sheets");
const Gorush = require("./notification-providers/gorush");
const Gotify = require("./notification-providers/gotify");
const GrafanaOncall = require("./notification-providers/grafana-oncall");
const HomeAssistant = require("./notification-providers/home-assistant");
const Indigo = require("./notification-providers/indigo");
const HeiiOnCall = require("./notification-providers/heii-oncall");
const Keep = require("./notification-providers/keep");
const Kook = require("./notification-providers/kook");
const Line = require("./notification-providers/line");
const LunaSea = require("./notification-providers/lunasea");
const Matrix = require("./notification-providers/matrix");
const Mattermost = require("./notification-providers/mattermost");
const NextcloudTalk = require("./notification-providers/nextcloudtalk");
const Nostr = require("./notification-providers/nostr");
const NotifyApp = require("./notification-providers/notifyapp");
const Ntfy = require("./notification-providers/ntfy");
const Octopush = require("./notification-providers/octopush");
const OneChat = require("./notification-providers/onechat");
const OneBot = require("./notification-providers/onebot");
const Ooredoo = require("./notification-providers/ooredoo");
const Opsgenie = require("./notification-providers/opsgenie");
const JiraServiceManagement = require("./notification-providers/jira-service-management");
const PagerDuty = require("./notification-providers/pagerduty");
const Pumble = require("./notification-providers/pumble");
const FlashDuty = require("./notification-providers/flashduty");
const Flowtriq = require("./notification-providers/flowtriq");
const PagerTree = require("./notification-providers/pagertree");
const Pinglet = require("./notification-providers/pinglet");
const Plivo = require("./notification-providers/plivo");
const PromoSMS = require("./notification-providers/promosms");
const Pushbullet = require("./notification-providers/pushbullet");
const PushDeer = require("./notification-providers/pushdeer");
const Pushover = require("./notification-providers/pushover");
const PushPlus = require("./notification-providers/pushplus");
const Pushy = require("./notification-providers/pushy");
const RocketChat = require("./notification-providers/rocket-chat");
const SerwerSMS = require("./notification-providers/serwersms");
const Signal = require("./notification-providers/signal");
const Signalgrid = require("./notification-providers/signalgrid");
const SIGNL4 = require("./notification-providers/signl4");
const Slack = require("./notification-providers/slack");
const SMSPartner = require("./notification-providers/smspartner");
const SMSEagle = require("./notification-providers/smseagle");
const SMSGateway = require("./notification-providers/sms-gateway");
const SMTP = require("./notification-providers/smtp");
const Squadcast = require("./notification-providers/squadcast");
const Stackfield = require("./notification-providers/stackfield");
const Teams = require("./notification-providers/teams");
const TechulusPush = require("./notification-providers/techulus-push");
const Telegram = require("./notification-providers/telegram");
const Teltonika = require("./notification-providers/teltonika");
const Telnyx = require("./notification-providers/telnyx");
const Threema = require("./notification-providers/threema");
const Twilio = require("./notification-providers/twilio");
const Splunk = require("./notification-providers/splunk");
const Webhook = require("./notification-providers/webhook");
const WeCom = require("./notification-providers/wecom");
const GoAlert = require("./notification-providers/goalert");
const SMSManager = require("./notification-providers/smsmanager");
const ServerChan = require("./notification-providers/serverchan");
const ZohoCliq = require("./notification-providers/zoho-cliq");
const SevenIO = require("./notification-providers/sevenio");
const Whapi = require("./notification-providers/whapi");
const WAHA = require("./notification-providers/waha");
const Evolution = require("./notification-providers/evolution");
const OpenWa = require("./notification-providers/openwa");
const GtxMessaging = require("./notification-providers/gtx-messaging");
const Cellsynt = require("./notification-providers/cellsynt");
const Onesender = require("./notification-providers/onesender");
const Wpush = require("./notification-providers/wpush");
const WxPusher = require("./notification-providers/wxpusher");
const SendGrid = require("./notification-providers/send-grid");
const TurboSMTP = require("./notification-providers/turbosmtp");
const Brevo = require("./notification-providers/brevo");
const Resend = require("./notification-providers/resend");
const YZJ = require("./notification-providers/yzj");
const AmootSMS = require("./notification-providers/amootsms");
const SMSPlanet = require("./notification-providers/sms-planet");
const SpugPush = require("./notification-providers/spugpush");
const SMSIR = require("./notification-providers/smsir");
const { commandExists } = require("./util-server");
const Whatsapp360messenger = require("./notification-providers/360messenger");
const Webpush = require("./notification-providers/Webpush");
const HaloPSA = require("./notification-providers/HaloPSA");
const Max = require("./notification-providers/max");
const VK = require("./notification-providers/vk");
const VKTeams = require("./notification-providers/vkteams");
const Milky = require("./notification-providers/milky");
const Talkin = require("./notification-providers/talkin");

class Notification {
    providerList = {};

    /**
     * Initialize the notification providers
     * @returns {void}
     * @throws Notification provider does not have a name
     * @throws Duplicate notification providers in list
     */
    static init() {
        log.debug("notification", "Prepare Notification Providers");

        this.providerList = {};

        const list = [
            new Alerta(),
            new AlertNow(),
            new AliyunSms(),
            new Apprise(),
            new Bale(),
            new Bark(),
            new BearSMS(),
            new Bitrix24(),
            new ClickUp(),
            new ClickSendSMS(),
            new CallMeBot(),
            new SMSC(),
            new DingDing(),
            new Discord(),
            new Fluxer(),
            new Elks(),
            new EgoSMS(),
            new Feishu(),
            new FreeMobile(),
            new GoogleChat(),
            new GoogleSheets(),
            new Gorush(),
            new Gotify(),
            new GrafanaOncall(),
            new HomeAssistant(),
            new Indigo(),
            new HeiiOnCall(),
            new Keep(),
            new Kook(),
            new Line(),
            new LunaSea(),
            new Matrix(),
            new Mattermost(),
            new NextcloudTalk(),
            new Nostr(),
            new NotifyApp(),
            new Ntfy(),
            new Octopush(),
            new OneChat(),
            new OneBot(),
            new Onesender(),
            new Ooredoo(),
            new Opsgenie(),
            new JiraServiceManagement(),
            new PagerDuty(),
            new FlashDuty(),
            new Flowtriq(),
            new PagerTree(),
            new Pinglet(),
            new Plivo(),
            new PromoSMS(),
            new Pumble(),
            new Pushbullet(),
            new PushDeer(),
            new Pushover(),
            new PushPlus(),
            new Pushy(),
            new RocketChat(),
            new ServerChan(),
            new SerwerSMS(),
            new Signal(),
            new Signalgrid(),
            new SIGNL4(),
            new SMSManager(),
            new SMSPartner(),
            new Slack(),
            new SMSEagle(),
            new SMSGateway(),
            new SMTP(),
            new Squadcast(),
            new Stackfield(),
            new Teams(),
            new TechulusPush(),
            new Telegram(),
            new Teltonika(),
            new Telnyx(),
            new Threema(),
            new Twilio(),
            new Splunk(),
            new Webhook(),
            new WeCom(),
            new GoAlert(),
            new ZohoCliq(),
            new SevenIO(),
            new Whapi(),
            new WAHA(),
            new Evolution(),
            new OpenWa(),
            new GtxMessaging(),
            new Cellsynt(),
            new Wpush(),
            new WxPusher(),
            new Brevo(),
            new Resend(),
            new YZJ(),
            new AmootSMS(),
            new SMSPlanet(),
            new SpugPush(),
            new Notifery(),
            new SMSIR(),
            new SendGrid(),
            new TurboSMTP(),
            new Whatsapp360messenger(),
            new Webpush(),
            new HaloPSA(),
            new Max(),
            new VK(),
            new VKTeams(),
            new Milky(),
            new Talkin(),
        ];
        for (let item of list) {
            if (!item.name) {
                throw new Error("Notification provider without name");
            }

            if (this.providerList[item.name]) {
                throw new Error("Duplicate notification provider name");
            }
            this.providerList[item.name] = item;
        }
    }

    /**
     * Send a notification
     * @param {BeanModel} notification Notification to send
     * @param {string} msg General Message
     * @param {object} monitorJSON Monitor details (For Up/Down only)
     * @param {object} heartbeatJSON Heartbeat details (For Up/Down only)
     * @returns {Promise<string>} Successful msg
     * @throws Error with fail msg
     */
    static async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        if (this.providerList[notification.type]) {
            return this.providerList[notification.type].send(notification, msg, monitorJSON, heartbeatJSON);
        } else {
            throw new Error("Notification type is not supported");
        }
    }

    /**
     * Save a notification
     * @param {object} notification Notification to save
     * @param {?number} notificationID ID of notification to update
     * @param {number} userID ID of user who adds notification
     * @returns {Promise<Bean>} Notification that was saved
     */
    static async save(notification, notificationID, userID) {
        let bean;

        if (notificationID) {
            bean = await R.findOne("notification", " id = ? AND user_id = ? ", [notificationID, userID]);

            if (!bean) {
                throw new Error("notification not found");
            }
        } else {
            bean = R.dispense("notification");
        }

        // Bulk apply options are one-time actions and must not be persisted.
        const applyExistingScope = normalizeApplyExistingScope(notification);
        const removeFromGroups = applyExistingScope === "non-group" && notification.removeFromGroups === true;
        const storedNotification = { ...notification };
        delete storedNotification.applyExisting;
        delete storedNotification.applyExistingScope;
        delete storedNotification.removeFromGroups;

        bean.name = notification.name;
        bean.user_id = userID;
        bean.config = JSON.stringify(storedNotification);
        bean.is_default = notification.isDefault || false;
        await R.store(bean);

        if (applyExistingScope !== "none") {
            await applyNotificationToMonitors(bean.id, userID, applyExistingScope, removeFromGroups);
        }

        return bean;
    }

    /**
     * Delete a notification
     * @param {number} notificationID ID of notification to delete
     * @param {number} userID ID of the owning user
     * @returns {Promise<void>}
     */
    static async delete(notificationID, userID) {
        let bean = await R.findOne("notification", " id = ? AND user_id = ? ", [notificationID, userID]);

        if (!bean) {
            throw new Error("notification not found");
        }

        await R.trash(bean);
    }

    /**
     * Preview a one-time bulk apply operation.
     * @param {?number} notificationID Existing notification ID, or null for a new notification
     * @param {number} userID ID of the current user
     * @param {string} scope Bulk apply scope
     * @param {boolean} removeFromGroups Whether existing group bindings should be removed
     * @returns {Promise<{ additions: number, removals: number }>} Binding changes
     */
    static async previewApply(notificationID, userID, scope, removeFromGroups) {
        if (notificationID) {
            const notification = await R.findOne("notification", " id = ? AND user_id = ? ", [notificationID, userID]);
            if (!notification) {
                throw new Error("notification not found");
            }
        }

        return getNotificationApplyPreview(notificationID, userID, scope, removeFromGroups);
    }

    /**
     * Check if apprise exists
     * @returns {Promise<boolean>} Does the command apprise exist?
     */
    static async checkApprise() {
        return await commandExists("apprise");
    }
}

/**
 * Normalize the one-time bulk apply scope while retaining compatibility with
 * clients that only send the legacy applyExisting boolean.
 * @param {object|string} notificationOrScope Notification payload or scope
 * @returns {"none"|"non-group"|"all"} Normalized scope
 */
function normalizeApplyExistingScope(notificationOrScope) {
    if (typeof notificationOrScope === "string") {
        return ["none", "non-group", "all"].includes(notificationOrScope) ? notificationOrScope : "none";
    }

    if (["none", "non-group", "all"].includes(notificationOrScope.applyExistingScope)) {
        return notificationOrScope.applyExistingScope;
    }

    return notificationOrScope.applyExisting === true ? "all" : "none";
}

/**
 * Preview a one-time notification bulk apply operation.
 * @param {?number} notificationID Notification ID; null when creating a notification
 * @param {number} userID ID of the current user
 * @param {string} scope Bulk apply scope
 * @param {boolean} removeFromGroups Whether group bindings should be removed
 * @returns {Promise<{ additions: number, removals: number }>} Binding changes
 */
async function getNotificationApplyPreview(notificationID, userID, scope, removeFromGroups) {
    const normalizedScope = normalizeApplyExistingScope(scope);
    if (normalizedScope === "none") {
        return { additions: 0, removals: 0 };
    }

    const typeFilter = normalizedScope === "non-group" ? "AND monitor.type != 'group'" : "";
    const additions = await R.getCell(
        `SELECT COUNT(*)
         FROM monitor
         WHERE monitor.user_id = ?
           ${typeFilter}
           AND NOT EXISTS (
               SELECT 1 FROM monitor_notification
               WHERE monitor_notification.monitor_id = monitor.id
                 AND monitor_notification.notification_id = ?
           )`,
        [userID, notificationID || 0]
    );

    let removals = 0;
    if (normalizedScope === "non-group" && removeFromGroups === true && notificationID) {
        removals = await R.getCell(
            `SELECT COUNT(*)
             FROM monitor_notification
             INNER JOIN monitor ON monitor.id = monitor_notification.monitor_id
             WHERE monitor_notification.notification_id = ?
               AND monitor.user_id = ?
               AND monitor.type = 'group'`,
            [notificationID, userID]
        );
    }

    return {
        additions: Number(additions),
        removals: Number(removals),
    };
}

/**
 * Apply a notification to monitors owned by one user.
 * @param {number} notificationID ID of notification to apply
 * @param {number} userID ID of the current user
 * @param {"non-group"|"all"} scope Bulk apply scope
 * @param {boolean} removeFromGroups Whether group bindings should be removed
 * @returns {Promise<void>}
 */
async function applyNotificationToMonitors(notificationID, userID, scope, removeFromGroups) {
    const normalizedScope = normalizeApplyExistingScope(scope);
    if (normalizedScope === "none") {
        return;
    }

    const trx = await R.begin();
    try {
        if (normalizedScope === "non-group" && removeFromGroups === true) {
            await trx.exec(
                `DELETE FROM monitor_notification
                 WHERE notification_id = ?
                   AND monitor_id IN (
                       SELECT id FROM monitor WHERE user_id = ? AND type = 'group'
                   )`,
                [notificationID, userID]
            );
        }

        const typeFilter = normalizedScope === "non-group" ? "AND monitor.type != 'group'" : "";
        await trx.exec(
            `INSERT INTO monitor_notification (monitor_id, notification_id)
             SELECT monitor.id, ?
             FROM monitor
             WHERE monitor.user_id = ?
               ${typeFilter}
               AND NOT EXISTS (
                   SELECT 1 FROM monitor_notification
                   WHERE monitor_notification.monitor_id = monitor.id
                     AND monitor_notification.notification_id = ?
               )`,
            [notificationID, userID, notificationID]
        );
        await trx.commit();
    } catch (error) {
        await trx.rollback();
        throw error;
    }
}

module.exports = {
    Notification,
    applyNotificationToMonitors,
    getNotificationApplyPreview,
    normalizeApplyExistingScope,
};
