import * as winston from "winston";
import * as http from "http";

import { Logger } from "./Logger";
import { WebServer } from "./WebServer";
import { WebSocketServer } from "./WebSocketServer";
import { DatabaseConnection } from "./DatabaseConnection";
import { Crypt } from "./Crypt";
import { Config } from "./Config";
import { amqpwrapper, QueueMessageOptions } from "./amqpwrapper";
import { WellknownIds, Role, Rights, User } from "openflow-api";
import { DBHelper } from "./DBHelper";

const logger: winston.Logger = Logger.configure();
Config.db = new DatabaseConnection(logger, Config.mongodb_url, Config.mongodb_db);


async function initamqp() {
    var amqp: amqpwrapper = new amqpwrapper(logger, Config.amqp_url);
    amqpwrapper.SetInstance(amqp);
    await amqp.connect();

    // Must also consume messages in the dead letter queue, to catch messages that have timed out
    await amqp.AddExchangeConsumer(Config.amqp_dlx, "fanout", "", null, null, (msg: any, options: QueueMessageOptions, ack: any, done: any) => {
        // This is the function to run when the dead letter (timed out) message is picked up
        // var data = JSON.parse(msg.content.toString());
        // Change the command and return back to the correct queue (replyTo) to be handled
        // Clear x-first-death-reason header
        // msg.properties.headers["x-first-death-reason"] = null;
        // Set command to timeout to be handled when collected from the node's queue
        if (typeof msg === "string" || msg instanceof String) {
            try {
                msg = JSON.parse((msg as any));
            } catch (error) {
            }
        }
        try {
            msg.command = "timeout";
            // Resend message, this time to the reply queue for the correct node (replyTo)
            // this.SendMessage(JSON.stringify(data), msg.properties.replyTo, msg.properties.correlationId, false);
            console.log("[DLX][" + options.exchange + "] Send timeout to " + options.replyTo)
            amqpwrapper.Instance().sendWithReply("", options.replyTo, msg, 20000, options.correlationId);
        } catch (error) {
        }
        ack();
        done();
    });

    // await amqp.AddExchangeConsumer("testexchange", "fanout", "", null, (msg: any, options: QueueMessageOptions, ack: any, done: any) => {
    //     console.log("testexchange: " + msg);
    //     ack();
    //     done(msg + " hi from testexchange");
    // });
    // await amqp.AddQueueConsumer("testqueue", null, (msg: any, options: QueueMessageOptions, ack: any, done: any) => {
    //     console.log("testqueue: " + msg);
    //     ack();
    //     done(msg + " hi from testqueue.1");
    // });
    // await amqp.AddQueueConsumer("testqueue", null, (msg: any, options: QueueMessageOptions, ack: any, done: any) => {
    //     console.log("tempqueue: " + msg);
    //     ack();
    //     done(msg + " hi from testqueue.2");
    // });
    // doitagain();
}
// var flipper: boolean = false;
// async function doitagain() {
//     try {
//         flipper = !flipper;
//         if (flipper) {
//             console.log(await amqpwrapper.Instance().sendWithReply("", "testqueue", "Hi mom", 20000, ""));
//         } else {
//             // console.log(await amqpwrapper.Instance().sendWithReply("", "testqueue2", "Hi mom", 2000));
//             console.log(await amqpwrapper.Instance().sendWithReply("testexchange", "", "Hi mom", 20000, ""));
//         }
//     } catch (error) {
//         console.log(error);
//     }
//     setTimeout(() => {
//         doitagain()
//     }, 5000);
// }


async function initDatabase(): Promise<boolean> {
    try {
        var jwt: string = Crypt.rootToken();
        var admins: Role = await DBHelper.EnsureRole(jwt, "admins", WellknownIds.admins);
        var users: Role = await DBHelper.EnsureRole(jwt, "users", WellknownIds.users);
        var root: User = await DBHelper.ensureUser(jwt, "root", "root", WellknownIds.root, null);

        root.addRight(WellknownIds.admins, "admins", [Rights.full_control]);
        root.removeRight(WellknownIds.admins, [Rights.delete]);
        root.addRight(WellknownIds.root, "root", [Rights.full_control]);
        root.removeRight(WellknownIds.root, [Rights.delete]);
        await DBHelper.Save(root, jwt);

        var robot_agent_users: Role = await DBHelper.EnsureRole(jwt, "robot agent users", WellknownIds.robot_agent_users);
        robot_agent_users.addRight(WellknownIds.admins, "admins", [Rights.full_control]);
        robot_agent_users.removeRight(WellknownIds.admins, [Rights.delete]);
        robot_agent_users.addRight(WellknownIds.root, "root", [Rights.full_control]);
        if (Config.multi_tenant) {
            logger.debug("[root][users] Running in multi tenant mode, remove " + robot_agent_users.name + " from self");
            robot_agent_users.removeRight(robot_agent_users._id, [Rights.full_control]);
        } else if (Config.update_acl_based_on_groups) {
            robot_agent_users.removeRight(robot_agent_users._id, [Rights.full_control]);
            robot_agent_users.addRight(robot_agent_users._id, "robot agent users", [Rights.read]);
        }
        await DBHelper.Save(robot_agent_users, jwt);

        admins.addRight(WellknownIds.admins, "admins", [Rights.full_control]);
        admins.removeRight(WellknownIds.admins, [Rights.delete]);
        await DBHelper.Save(admins, jwt);

        users.addRight(WellknownIds.admins, "admins", [Rights.full_control]);
        users.removeRight(WellknownIds.admins, [Rights.delete]);
        users.AddMember(root);
        if (Config.multi_tenant) {
            users.removeRight(users._id, [Rights.full_control]);
        } else {
            users.removeRight(users._id, [Rights.full_control]);
            users.addRight(users._id, "users", [Rights.read]);
        }
        await DBHelper.Save(users, jwt);


        var personal_nodered_users: Role = await DBHelper.EnsureRole(jwt, "personal nodered users", WellknownIds.personal_nodered_users);
        personal_nodered_users.AddMember(admins);
        personal_nodered_users.addRight(WellknownIds.admins, "admins", [Rights.full_control]);
        personal_nodered_users.removeRight(WellknownIds.admins, [Rights.delete]);
        if (Config.multi_tenant) {
            logger.debug("[root][users] Running in multi tenant mode, remove " + personal_nodered_users.name + " from self");
            personal_nodered_users.removeRight(personal_nodered_users._id, [Rights.full_control]);
        } else if (Config.update_acl_based_on_groups) {
            personal_nodered_users.removeRight(personal_nodered_users._id, [Rights.full_control]);
            personal_nodered_users.addRight(personal_nodered_users._id, "personal nodered users", [Rights.read]);
        }
        await DBHelper.Save(personal_nodered_users, jwt);
        var nodered_admins: Role = await DBHelper.EnsureRole(jwt, "nodered admins", WellknownIds.nodered_admins);
        nodered_admins.AddMember(admins);
        nodered_admins.addRight(WellknownIds.admins, "admins", [Rights.full_control]);
        nodered_admins.removeRight(WellknownIds.admins, [Rights.delete]);
        await DBHelper.Save(nodered_admins, jwt);
        var nodered_users: Role = await DBHelper.EnsureRole(jwt, "nodered users", WellknownIds.nodered_users);
        nodered_users.AddMember(admins);
        nodered_users.addRight(WellknownIds.admins, "admins", [Rights.full_control]);
        nodered_users.removeRight(WellknownIds.admins, [Rights.delete]);
        if (Config.multi_tenant) {
            logger.debug("[root][users] Running in multi tenant mode, remove " + nodered_users.name + " from self");
            nodered_users.removeRight(nodered_users._id, [Rights.full_control]);
        } else if (Config.update_acl_based_on_groups) {
            nodered_users.removeRight(nodered_users._id, [Rights.full_control]);
            nodered_users.addRight(nodered_users._id, "nodered users", [Rights.read]);
        }
        await DBHelper.Save(nodered_users, jwt);
        var nodered_api_users: Role = await DBHelper.EnsureRole(jwt, "nodered api users", WellknownIds.nodered_api_users);
        nodered_api_users.AddMember(admins);
        nodered_api_users.addRight(WellknownIds.admins, "admins", [Rights.full_control]);
        nodered_api_users.removeRight(WellknownIds.admins, [Rights.delete]);
        if (Config.multi_tenant) {
            logger.debug("[root][users] Running in multi tenant mode, remove " + nodered_api_users.name + " from self");
            nodered_api_users.removeRight(nodered_api_users._id, [Rights.full_control]);
        } else if (Config.update_acl_based_on_groups) {
            nodered_api_users.removeRight(nodered_api_users._id, [Rights.full_control]);
            nodered_api_users.addRight(nodered_api_users._id, "nodered api users", [Rights.read]);
        }
        await DBHelper.Save(nodered_api_users, jwt);

        var robot_admins: Role = await DBHelper.EnsureRole(jwt, "robot admins", WellknownIds.robot_admins);
        robot_admins.AddMember(admins);
        robot_admins.addRight(WellknownIds.admins, "admins", [Rights.full_control]);
        robot_admins.removeRight(WellknownIds.admins, [Rights.delete]);
        await DBHelper.Save(robot_admins, jwt);
        var robot_users: Role = await DBHelper.EnsureRole(jwt, "robot users", WellknownIds.robot_users);
        robot_users.AddMember(admins);
        robot_users.AddMember(users);
        robot_users.addRight(WellknownIds.admins, "admins", [Rights.full_control]);
        robot_users.removeRight(WellknownIds.admins, [Rights.delete]);
        if (Config.multi_tenant) {
            logger.debug("[root][users] Running in multi tenant mode, remove " + robot_users.name + " from self");
            robot_users.removeRight(robot_users._id, [Rights.full_control]);
        } else if (Config.update_acl_based_on_groups) {
            robot_users.removeRight(robot_users._id, [Rights.full_control]);
            robot_users.addRight(robot_users._id, "robot users", [Rights.read]);
        }
        await DBHelper.Save(robot_users, jwt);

        if (!admins.IsMember(root._id)) {
            admins.AddMember(root);
            await DBHelper.Save(admins, jwt);
        }

        var filestore_admins: Role = await DBHelper.EnsureRole(jwt, "filestore admins", WellknownIds.filestore_admins);
        filestore_admins.AddMember(admins);
        filestore_admins.addRight(WellknownIds.admins, "admins", [Rights.full_control]);
        filestore_admins.removeRight(WellknownIds.admins, [Rights.delete]);
        if (Config.multi_tenant) {
            logger.debug("[root][users] Running in multi tenant mode, remove " + filestore_admins.name + " from self");
            filestore_admins.removeRight(filestore_admins._id, [Rights.full_control]);
        }
        await DBHelper.Save(filestore_admins, jwt);
        var filestore_users: Role = await DBHelper.EnsureRole(jwt, "filestore users", WellknownIds.filestore_users);
        filestore_users.AddMember(admins);
        if (!Config.multi_tenant) {
            filestore_users.AddMember(users);
        }
        filestore_users.addRight(WellknownIds.admins, "admins", [Rights.full_control]);
        filestore_users.removeRight(WellknownIds.admins, [Rights.delete]);
        if (Config.multi_tenant) {
            logger.debug("[root][users] Running in multi tenant mode, remove " + filestore_users.name + " from self");
            filestore_users.removeRight(filestore_users._id, [Rights.full_control]);
        } else if (Config.update_acl_based_on_groups) {
            filestore_users.removeRight(filestore_users._id, [Rights.full_control]);
            filestore_users.addRight(filestore_users._id, "filestore users", [Rights.read]);
        }
        await DBHelper.Save(filestore_users, jwt);
        return true;
    } catch (error) {
        logger.error(error);
        return false;
    }
}



const unhandledRejection = require("unhandled-rejection");
let rejectionEmitter = unhandledRejection({
    timeout: 20
});

rejectionEmitter.on("unhandledRejection", (error, promise) => {
    console.log('Unhandled Rejection at: Promise', promise, 'reason:', error);
    console.dir(error.stack);
});

rejectionEmitter.on("rejectionHandled", (error, promise) => {
    console.log('Rejection handled at: Promise', promise, 'reason:', error);
    console.dir(error.stack);
});
import * as fs from "fs";
import { OAuthProvider } from "./OAuthProvider";
var GrafanaProxy: any = null;
try {
    GrafanaProxy = require("./grafana-proxy");
} catch (error) {

}

(async function (): Promise<void> {
    try {
        await initamqp();
        // var wait = ms => new Promise((r, j) => setTimeout(r, ms));
        // await wait(2000);
        // await Config.get_login_providers();
        logger.info("VERSION: " + Config.version);
        const server: http.Server = await WebServer.configure(logger, Config.baseurl());
        if (GrafanaProxy != null) {
            const grafana = await GrafanaProxy.GrafanaProxy.configure(logger, WebServer.app);
        }
        OAuthProvider.configure(logger, WebServer.app);
        WebSocketServer.configure(logger, server);
        logger.info("listening on " + Config.baseurl());
        logger.info("namespace: " + Config.namespace);
        if (!await initDatabase()) {
            process.exit(404);
        }
    } catch (error) {
        // logger.error(error.message);
        console.error(error);
        var json = JSON.stringify(error, null, 3);
        console.error(json);

    }
})();
