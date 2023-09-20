// version: 0.1.0
let CONFIG = {
    api_key: "YOUR-API-KEY-HERE", // your Tibber API key
    cycleTimeout: 30 * 60, // time in seconds of no power use after which the cycle is considered finished
    cycleStartOffset: (-25 * 60),  // offset the cycle start by this time in seconds
    minPower: 6, // minimum power in W that is considered as the dishwasher running
    waitUntilHour: 3 // hour of the day when the dishwasher should be started if API fails
};

let state = "startup"; //  startup, armed, waiting, running
let currentPower = 0;
let lastTimePowerUsed = new Date();
let waitUntil = new Date();

// helper function to print with timestamp
function log() {
    date = new Date();
    let date_string = (date.getMonth() + 1) + "-" + date.getDate() + " ";
    date_string += date.getHours() + ":" + date.getMinutes() + ":" + date.getSeconds() + ": ";
    arguments[0] = date_string + arguments[0];
    print.apply(null, arguments);
}

//
// Tibber API related logic
//

// this query should not be changed
const query = "{viewer{homes{currentSubscription{priceInfo{today{total}tomorrow{total}}}}}}"

function call_tibber_api() {
    let params = {
        method: "POST",
        url: "https://api.tibber.com/v1-beta/gql",
        body: { "query": query },
        headers: { "Authorization": "Bearer " + CONFIG.api_key }
    }
    Shelly.call("HTTP.Request",
        params,
        tibber_callback,
        null
    );
}

function tibber_callback(result, error_code, error_message, userdata) {
    if (error_code != 0 || result.code != 200) {
        log("Tibber API failed, falling back to default schedule");
        scheduleFallback();
    }

    let json = JSON.parse(result.body);
    let today = json.data.viewer.homes[0].currentSubscription.priceInfo.today;
    let tomorrow = json.data.viewer.homes[0].currentSubscription.priceInfo.tomorrow;

    let prices = [];
    for (let i = 0; i < today.length; i++) {
        prices.push(today[i].total);
    }
    for (let i = 0; i < tomorrow.length; i++) {
        prices.push(tomorrow[i].total);
    }

    waitUntil = get_cheapest_tibber_time(prices);
    scheduleNextRunFinish();
}

// this gets called if the Tibber API fails
function scheduleFallback() {
    log("scheduleFallback");
    let d = new Date();

    let delta = CONFIG.waitUntilHour * 60 * 60; //desired hour of day later

    if (d.getHours() > CONFIG.waitUntilHour) {
        delta += 24 * 60 * 60 //24 hours later
    }

    delta -= d.getSeconds(); //current seconds earlier
    delta -= d.getMinutes() * 60; //current minutes earlier
    delta -= d.getHours() * 60 * 60; //current hours earlier

    delta += CONFIG.cycleStartOffset; //configured offset

    waitUntil = new Date(d.getTime() + delta * 1000);
    scheduleNextRunFinish();
}

function get_cheapest_tibber_time(prices) {
    let date = new Date();
    let starting_hour = date.getHours();

    let cheapest_hour = starting_hour;
    for (let i = starting_hour; i < prices.length; i++) {
        if (prices[i] < prices[cheapest_hour]) {
            cheapest_hour = i;
        }
    }

    let time_offset = (cheapest_hour - starting_hour) * 60 * 60 - date.getMinutes() * 60 - date.getSeconds() + CONFIG.cycleStartOffset;
    return new Date(date.getTime() + time_offset * 1000);
}

function scheduleNextRun() {
    if (CONFIG.api_key === "YOUR-API-KEY-HERE") {
        log("Tibber API key not set, falling back to default schedule. Please set your API key in the script.");
        scheduleFallback();
        return;
    }
    call_tibber_api();
}

function scheduleNextRunFinish() {
    if (waitUntil < new Date()) {
        log("dishwasher was started after target time, doing nothing, target time:", waitUntil);
    } else {
        log("dishwasher was started, turning Shelly Switch off");
        log("cycle will resume at", waitUntil)
        Shelly.call("Switch.set", { 'id': 0, 'on': false });
    }
    Timer.set(1000, false, main_power)
}

// add handler for switch status changes
Shelly.addStatusHandler(function (e) {
    if (e.component === "switch:0") {
        if (e.delta.output === true) {
            // change state to running if dishwasher was started manually
            if (e.delta.source !== "loopback" && state === "waiting") {
                lastTimePowerUsed = new Date();
                state = "running";
            }
        } else if (e.delta.output === false) {
            // change state to waiting if dishwasher was stopped manually
            if (e.delta.source !== "loopback" && state !== "waiting") {
                scheduleNextRun();
                state = "waiting";
            }
        }
    }
});

function main_start() {
    Shelly.call(
        "switch.getStatus",
        { id: 0 },
        function (res, error_code, error_msg, ud) {
            if (res.output === true) {
                log("shelly relay is on");
                main_power();
            } else {
                log("shelly relay is off, initializing in waiting state");
                state = "waiting"
                scheduleNextRun();
            }
        }
    );
}

function main_power() {
    Shelly.call(
        "switch.getStatus",
        { id: 0 },
        function (res, error_code, error_msg, ud) {
            currentPower = res.apower;
            if (currentPower > CONFIG.minPower) {
                log("updating lastTimePowerUsed, power is", currentPower, "W");
                lastTimePowerUsed = new Date();
            }
            main_states();
        }
    );
}

function main_states() {
    if (state === "startup") {
        log("startup state");
        if (currentPower > CONFIG.minPower) {
            log("initializing in running state")
            state = "running";
        } else {
            log("initializing in armed state")
            state = "armed";
        }
    } else if (state === "armed") {
        if (currentPower > CONFIG.minPower) {
            state = "waiting";
            scheduleNextRun();
            return;
        }
    } else if (state === "waiting") {
        if (new Date() > waitUntil) {
            state = "running";
            //avoid new cycle to be considered finished right away and ending up in armed and then waiting state
            lastTimePowerUsed = new Date();
            log("restarting cycle, turning Shelly Switch on");
            Shelly.call("Switch.set", { 'id': 0, 'on': true });
        }
    } else if (state === "running") {
        log(Math.round(((new Date()).getTime() - lastTimePowerUsed.getTime()) / 1000), "seconds since last power usage");
        if ((new Date()).getTime() - lastTimePowerUsed.getTime() > CONFIG.cycleTimeout * 1000) {
            state = "armed";
            log("cycle finished");
        }
    }
    Timer.set(1000, false, main_power)
};

log("starting at", new Date());
main_start();


// TODO: grace period after cycle is started, and then shorter cycle timeout?
// TODO: consider blocks of two hours instead of one hour for price calc, perhaps a weighted list of 1hr blocks?
// TODO: increase price of blocks by x% vs cheapest price to penalize blocks far in the future