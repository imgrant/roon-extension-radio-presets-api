// Initialize Roon APIs
var RoonApi           = require("node-roon-api"),
    RoonApiBrowse     = require("node-roon-api-browse"),
    RoonApiTransport  = require("node-roon-api-transport"),
    RoonApiStatus     = require("node-roon-api-status"),
    RoonApiSettings   = require("node-roon-api-settings"),
    transport,
    browser,
    zones = [],
    station_list = [];

const NO_PRESET_VALUE = "None (disabled)";

// Initialize Express.js
var express = require('express'),
    app = express();

var roon = new RoonApi({
    extension_id:        'me.iangrant.radio-presets-api',
    display_name:        "Radio Presets API Trigger",
    display_version:     "1.0.0",
    publisher:           'Ian Grant',
    email:               'ian@iangrant.me',
    website:             'https://github.com/imgrant/roon-extension-radio-presets-api',
    
    // Handler: on connection with Roon core
    core_paired: function(core) {
        // Connect to transport service
        transport = core.services.RoonApiTransport;
        transport.subscribe_zones(function(cmd, data) {
            // On first connection to core, populate zones list and log zone names and ids
            if (cmd == "Subscribed") {
                zones = data.zones;
            // On zone change, update the zone list
            } else if (cmd == "Changed") {
                if ("zones_added" in data) {
                    for (let item in data.zones_added) {
                        if (! get_zone(data.zones_added[item].display_name)) {
                            zones.push(data.zones_added[item]);
                        }
                    }
                } else if ("zones_removed" in data) {
                    for (let item in data.zones_removed) {
                        zones.splice(zones.indexOf(transport.zone_by_zone_id(data.zones_removed[item])), 1);
                    }
                } else if ("zones_changed" in data) {
                    data.zones_changed.forEach(changed_zone => {
                        zones.forEach( (existing_zone, index) => {
                            if (existing_zone.zone_id == changed_zone.zone_id) {
                                zones[index] = changed_zone;
                            }
                        });
                    });
                }
            // Should not fire...
            } else {
                console.log("Error: unhandled command...");
            }
        });
        // Connect to browser service
        browser = core.services.RoonApiBrowse;
    },

    // Handler: on disconnection from Roon core
    core_unpaired: function(core) {
        console.log("Lost connection to Roon core")
    }
});

// Status handler
var svc_status = new RoonApiStatus(roon);

// Extension settings
var presets = roon.load_config("settings") || {
    preset_1: NO_PRESET_VALUE,
    preset_2: NO_PRESET_VALUE,
    preset_3: NO_PRESET_VALUE,
    preset_4: NO_PRESET_VALUE,
    preset_5: NO_PRESET_VALUE,
    preset_6: NO_PRESET_VALUE
};

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        fetch_station_list( () => {
            cb(makelayout(presets));
        });
    },

    save_settings: function(req, isdryrun, settings) {
        let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });
        if (!isdryrun && !l.has_error) { 
            presets = l.values;
            svc_settings.update_settings(l);
            roon.save_config("settings", presets);
        }
    }
});

function makelayout(settings) {
    let l = {
        values:    settings,
        layout:    [],
        has_error: false
    };
    for (i=1; i<=6; i++) {
        l.layout.push({
            type:    "dropdown",
            title:   "Preset " + i,
            values:  station_list,
            setting: "preset_" + i
        });
    }
    return l;
}

// Populate list of user's available stations, transform for settings dropdowns
function fetch_station_list(cb) {
    let opts = {
        hierarchy: "internet_radio",
        pop_all: true
    };
    load_browse_result(opts, (result) => {
        // Using null for the value of the 'None' entry doesn't seem to work...
        station_list = [{ title: "None (disabled)", value: NO_PRESET_VALUE }].concat(
            result.map(item => { 
                return { title: item.title, value: item.title }
            })
        );
        cb && cb();
    });
}

// Helper function for fetching stations (or other)
function load_browse_result(opts, cb) {
    browser.browse(opts, (err,r) => {
        if (err) { console.log(err, r); return; }
        browser.load(opts, (err, r) => {
            if (err) {
                console.log(err, r);
                return;
            } else if (cb) {
                cb(r.items);
            }
        });
    });
}

// Helper function to look up zone object from ID string or display name
function get_zone(id_or_display_name) {
    for (item in zones) {
        if (id_or_display_name == zones[item].zone_id || id_or_display_name == zones[item].display_name) {
            return zones[item];
        }
    }
    // Zone not found
    return null;
}

// Radio preset request handler
function radio_preset(zone, preset) {
    let opts = {
        hierarchy:  "internet_radio",
        pop_all:    true
    };
    let preset_title = presets["preset_" + preset];
    if (preset_title == NO_PRESET_VALUE) {
        console.log("Preset " + preset + " is not set");
    } else {
        load_browse_result(opts, (stations) => {
            stations.forEach(radio => {
                if (radio["title"] == preset_title) {
                    console.log("Preset station found, playing " + radio["title"] + " on zone " + zone.display_name);
                    opts["zone_or_output_id"]   = zone.zone_id;
                    opts["item_key"]            = radio["item_key"];                
                    opts["pop_all"]             = false;
                    browser.browse(opts);
                    return true;
                }
            });
            // If the preset station wasn't found, we end up here
            console.log("Error: preset " + preset + " station not found (" + preset_title + ")");
            return false;
        });
    }
}

// Expose and consume the following services to/from Roon core:
roon.init_services({
    // Provide status of extension
    provided_services: [ svc_status, svc_settings ],
    // Require access to transport control and browse interface
    required_services: [ RoonApiTransport, RoonApiBrowse ]
});

// Set status on connection with core (can be viewed in Roon: Settings -> Extensions)
svc_status.set_status("Extension starting ...", false);

// Start discovery to find Roon core (this is for pairing with a single core only)
roon.start_discovery();

// API endpoint handler, which accepts incoming HTTP GET requests
// formatted as, e.g.: http://<host>:<port>/api?preset=<number>&zone=<zone>
// -> preset:   Numbered preset corresponding to the ratio station to play
// -> zone:     Zone display name, such as Living Room (must be URL-encoded, e.g 'Living Room' = 'Living%20Room'), or zone ID (e.g. 16010ca1ea807d48b5531c73e2e1326c4932)
// -> host:     Hostname or IP address of where the extension is running (may or may not be the same as the Roon core in your setup!)
// -> port:     The listening port is defined below
app.get("/api", function(req, res) {
    // Response can be customized as Express.js allows
    if (req.query.preset && req.query.zone) {
        res.end()
        console.log("Preset requested: " + req.query.preset + ", zone: " + req.query.zone);
        let preset = req.query.preset,
            zone = get_zone(req.query.zone);
        if (zone) {
            console.log("Zone matched: " + zone.zone_id);
            // If the zone is found (i.e. not null) pass to radio preset function
            radio_preset(zone, preset);
        } else {
            console.log("Error: zone not found");
        }
    } else if (req.query.get_presets) {
        res.send(presets);        
    } else if (req.query.get_zones) {
        let content = [];
        zones.forEach(zone => {
            content.push({ name: zone.display_name, id: zone.zone_id });
        });
        res.send(content);
    }
});

// Start the server
let server_opts = {
    "host":     "0.0.0.0",   // for any/all interfaces, use :: or 0.0.0.0
    "port":     18161,
    "ipv6Only": false   // for IPv4 only, use 0.0.0.0 for host to listen on any/all interfaces; use :: when this is set to true
}
var server = app.listen(server_opts, function() {
    let listeners = [];
    let status = [];
    
    if (server.address().address == "0.0.0.0" || server.address().address == "::") {
        var os = require('os');
        var ifaces = os.networkInterfaces();
        Object.keys(ifaces).forEach(function (ifname) {
            ifaces[ifname].forEach(function (iface) {
                if ( (server.address().address == "0.0.0.0" && 'IPv4' !== iface.family) || iface.internal !== false ) {
                    // Skip localhost and, if listening to IPv4 only, any IPv6 addresses
                    return;
                }
                if ( server.address().address == "::" && server_opts.ipv6Only == true && 'IPv6' !== iface.family ) {
                    // If listening to IPv6 only, skip any IPv4 addresses
                    return;
                }
                console.log("Extension server listening on " + iface.address + ":" + server.address().port);
                listeners.push(iface.address + ":" + server.address().port);
            });
        });    
    } else {
        console.log("Extension server listening on " + server.address().address + ":" + server.address().port);
        listeners.push(server.address().address + ":" + server.address().port);
    }

    listeners.forEach(function (listener) {
        status.push("API endpoint available at http://"+ listener + "/api");
    });
    svc_status.set_status(status.join("\n"), false);
});
