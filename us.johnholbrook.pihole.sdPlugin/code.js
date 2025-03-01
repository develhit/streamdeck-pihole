var websocket = null;
var instances = {}

// Envía datos a través del websocket
function send(data){
    websocket.send(JSON.stringify(data));
}

// Escribe un mensaje en el log
function log(message){
    send({
        "event": "logMessage",
        "payload": {
            "message": message
        }
    });
}

// Realiza una llamada a la API para habilitar o deshabilitar Pi-hole
function callPiHole(settings, cmd){
    // Si el comando indica una deshabilitación temporal (por ejemplo, "disable=300")
    let endpoint = '';
    if(cmd.startsWith('disable=')){
        // Para la deshabilitación temporal, se utiliza el endpoint "disable" con el parámetro "duration"
        endpoint = `disable?duration=${settings.disable_time}`;
    }
    else{
        // Para habilitar o deshabilitar sin parámetros adicionales ("enable" o "disable")
        endpoint = cmd;
    }
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/${endpoint}?auth=${settings.ph_key}`;
    // log(`call request to ${req_addr}`);
    let xhr = new XMLHttpRequest();
    xhr.open("GET", req_addr);
    xhr.send();
}

// Obtiene el estado de Pi-hole (habilitado/deshabilitado, estadísticas, etc.) y lo envía a la función handler
function get_ph_status(settings, handler){
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/summary?auth=${settings.ph_key}`;
    // log(`get_status request to ${req_addr}`);
    let xhr = new XMLHttpRequest();
    xhr.open("GET", req_addr);
    xhr.onload = function(){
        let data = JSON.parse(xhr.response);
        handler(data);
    }
    xhr.onerror = function(){
        handler({"error": "couldn't reach Pi-hole"});
    }
    xhr.send();
}

// Manejador de evento para deshabilitar temporalmente
function temporarily_disable(context){
    let settings = instances[context].settings;
    get_ph_status(settings, response => {
        if (response.status == "enabled"){  // tiene sentido deshabilitar temporalmente solo si está habilitado
            callPiHole(settings, `disable=${settings.disable_time}`);
        }
    });
}

// Manejador de evento para alternar el estado de Pi-hole
function toggle(context){
    let settings = instances[context].settings;
    get_ph_status(settings, response => {
        if (response.status == "disabled"){
            callPiHole(settings, "enable");
            setState(context, 0);
        }
        else if (response.status == "enabled"){
            callPiHole(settings, "disable");
            setState(context, 1);
        }
    });
}

// Manejador de evento para deshabilitar
function disable(context){
    let settings = instances[context].settings;
    callPiHole(settings, "disable");
}

// Manejador de evento para habilitar
function enable(context){
    let settings = instances[context].settings;
    callPiHole(settings, "enable");
}

// Consulta periódica al estado de Pi-hole y actualiza el estado y el texto del botón
// (se ejecuta una vez por segundo para cada instancia)
function pollPihole(context){
    let settings = instances[context].settings;
    get_ph_status(settings, response => {
        if ("error" in response){ // no se pudo alcanzar a Pi-hole, se muestra una alerta
            send({
                "event": "showAlert",
                "context": context
            });
            log(response);
        }
        else{
            // Actualiza el estado según si Pi-hole está habilitado o deshabilitado
            if (response.status == "disabled" && settings.show_status){
                setState(context, 1);
            }
            else if (response.status == "enabled" && settings.show_status){
                setState(context, 0);
            }

            // Muestra alguna estadística, si se ha configurado
            if (settings.stat != "none"){
                let stat = process_stat(response[settings.stat], settings.stat);
                send({
                    "event": "setTitle",
                    "context": context,
                    "payload": {
                        "title": stat
                    }
                });
            }
        }
    });
}

// Procesa las estadísticas de Pi-hole para hacerlas más legibles
function process_stat(value, type){
    if (type == "ads_percentage_today"){
        return value.toFixed(2) + "%";
    }
    else{
        return String(value);
    }
}

// Cambia el estado del botón (el parámetro "state" debe ser 0 o 1)
function setState(context, state){
    let json = {
        "event" : "setState",
        "context" : context,
        "payload" : {
            "state" : state
        }
    };
    websocket.send(JSON.stringify(json));
}

// Actualiza la dirección de Pi-hole, la clave API o el tiempo de deshabilitación
function updateSettings(payload){
    if ("disable_time" in payload){
        time = payload.disable_time;
    }
    if ("ph_key" in payload){
        ph_key = payload.ph_key;
    }
    if ("ph_addr" in payload){
        ph_addr = payload.ph_addr;
    }
}

// Escribe y configura los settings
function writeSettings(context, action, settings){
    if (!(context in instances)){ 
        instances[context] = {"action": action};
    }
    instances[context].settings = settings;
    if (instances[context].settings.ph_addr == ""){
        instances[context].settings.ph_addr = "pi.hole";
    }

    // Inicia la consulta periódica del estado
    if ("poller" in instances[context]){
        clearInterval(instances[context].poller);
    }
    instances[context].settings.show_status = true;
    instances[context].poller = setInterval(pollPihole, 1000, context);
    log(JSON.stringify(instances));
}

// Función llamada por el software del Stream Deck cuando se inicializa el plugin
function connectElgatoStreamDeckSocket(inPort, inPluginUUID, inRegisterEvent, inInfo){
    websocket = new WebSocket("ws://localhost:" + inPort);
    websocket.onopen = function(){
        // Al conectarse el websocket, se registra el plugin
        var json = {
            "event": inRegisterEvent,
            "uuid": inPluginUUID
        };
        websocket.send(JSON.stringify(json));
    };

    // Manejador de mensajes
    websocket.onmessage = function(evt){
        let jsonObj = JSON.parse(evt.data);
        let event = jsonObj.event;
        let action = jsonObj.action;
        let context = jsonObj.context;

        console.log(`${action} ${event}`);

        // Actualiza la configuración para esta instancia
        if (event == "didReceiveSettings"){
            writeSettings(context, action, jsonObj.payload.settings);
        }
        else if (event == "willAppear"){
            writeSettings(context, action, jsonObj.payload.settings);
        }
        else if (event == "willDisappear"){
            if ("poller" in instances[context]){
                clearInterval(instances[context].poller);
            }
            delete instances[context];
        }
        // Maneja la pulsación de una tecla
        else if (event == "keyUp"){
            if (action == "us.johnholbrook.pihole.toggle"){
                toggle(context);
            }
            else if (action == "us.johnholbrook.pihole.temporarily-disable"){
                temporarily_disable(context);
            }
            else if (action == "us.johnholbrook.pihole.disable"){
                disable(context);
            }
            else if (action == "us.johnholbrook.pihole.enable"){
                enable(context);
            }
        }
    }
}
