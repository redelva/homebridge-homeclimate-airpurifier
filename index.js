const WebSocket = require('ws');
const axios = require('axios');
let Service, Characteristic;
let devices = [];

//resultCode
const INIT_RESULT_CODE = 0; // 出示话数据
const SUCCESS_RESULT_CODE = 1; // 数据解析回复正确
const FAIL_RESULT_CODE = 2; // 数据解析回复失败
const SEND_SUCCESS_RESULT_CODE = 3; // 数据发送成功
const PU_LOGOUT_CODE = 4; // 设备离线
const UNSUPPORT_PU_KIND = 5; // 不支持此设备类型
const UNSUPPORT_PU_MODEL = 6; // 不支持此设备型号
const UNSUPPORT_PU_ACTION_NAME = 7; // 不支持此actionName方法
const SEND_FAIL_RESULT_CODE = 8; // 发送失败
const PU_ONLINE_RESULT_CODE = 9; // 设备上线
const PU_OFFLINE_RESULT_CODE = 10; // 设备下线

//actionNameAck
const actionNameAck_refreshPuState = "refreshPuState";
const actionNameAck_refreshAll = "refreshAll";
const ACK_SET_PM25_STATE_VALUE = "pm25StateValue";

const final_318_getMainState = "getMainState"; //查询信息
const final_318_cmd02 = "cmd02"; //设置开关机
const final_318_cmd03 = "cmd03"; //调节风量
const final_318_cmd04 = "cmd04"; //风阀开关
const final_318_cmd05 = "cmd05"; //睡眠

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerAccessory('homebridge-homeclimate-airpurifier', 'HomeClimateAirPurifier', HomeClimateAirPurifier);
}

function HomeClimateAirPurifier(log, config) {
    this.log = log;
    // cuId + "~" + puId + "~" + token + "~" + final_type_model_puId.split('_')[1]
    // 299636~213444~~318~
    this.cuId = config.cuId; //299636
    this.puId = config.puId; //213444
    this.model = config.model;//318
    this.kindId = config.kindId;//300
    this.token = config.token;
    this.ts = config.ts;

    //1616594775042
    this.url = "ws://cloudh5.51miaomiao.com/servlet/SwapDataServlet?cuId=" + this.cuId + "~" + this.puId + "~" + this.token + "~" + this.model + "~" + this.ts;

    this.name = config.name || 'Air Purifier';
    this.showAirQuality = config.showAirQuality || false;
    this.showTemperature = config.showTemperature || false;
    this.showHumidity = config.showHumidity || false;
    this.showLED = config.showLED || false;

    this.nameAirQuality = config.nameAirQuality || 'Air Quality';
    this.nameTemperature = config.nameTemperature || 'Temperature';
    this.nameHumidity = config.nameHumidity || 'Humidity';

    this.ws = null;
    this.state = {
        accumulateWorkTime:0, //累计工作时间
        airFlowRate:50, //风量
        activeMode:0,//开关机状态
        sleepMode:1,//睡眠
        airValveMode:0,//风阀开关
        airTemperature:0,//送风温度
    };
    this.temperature = null;
    this.humidity = null;
    this.aqi = null;
    this.pm25 = null;

    this.levels = [
        [200, Characteristic.AirQuality.POOR],
        [150, Characteristic.AirQuality.INFERIOR],
        [100, Characteristic.AirQuality.FAIR],
        [50, Characteristic.AirQuality.GOOD],
        [0, Characteristic.AirQuality.EXCELLENT],
    ];

    this.services = [];

    this.service = new Service.AirPurifier(this.name);

    this.service
        .getCharacteristic(Characteristic.Active)
        .on('get', this.getActiveState.bind(this))
        .on('set', this.setActiveState.bind(this));

    this.service
        .getCharacteristic(Characteristic.CurrentAirPurifierState)
        .on('get', this.getCurrentAirPurifierState.bind(this));

    this.service
        .getCharacteristic(Characteristic.TargetAirPurifierState)
        .on('get', this.getTargetAirPurifierState.bind(this))
        .on('set', this.setTargetAirPurifierState.bind(this));

    this.service
        .getCharacteristic(Characteristic.LockPhysicalControls)
        .on('get', this.getLockPhysicalControls.bind(this))
        .on('set', this.setLockPhysicalControls.bind(this));

    this.service
        .getCharacteristic(Characteristic.RotationSpeed)
        .on('get', this.getRotationSpeed.bind(this))
        .on('set', this.setRotationSpeed.bind(this));

    this.serviceInfo = new Service.AccessoryInformation();

    this.serviceInfo
        .setCharacteristic(Characteristic.Manufacturer, 'Home Climate')
        .setCharacteristic(Characteristic.Model, 'Air Purifier');

    this.services.push(this.service);
    this.services.push(this.serviceInfo);

    if (this.showAirQuality) {
        this.airQualitySensorService = new Service.AirQualitySensor(this.nameAirQuality);

        this.airQualitySensorService
            .getCharacteristic(Characteristic.AirQuality)
            .on('get', this.getAirQuality.bind(this));

        this.airQualitySensorService
            .getCharacteristic(Characteristic.PM2_5Density)
            .on('get', this.getPM25.bind(this));

        this.services.push(this.airQualitySensorService);
    }

    if (this.showTemperature) {
        this.temperatureSensorService = new Service.TemperatureSensor(this.nameTemperature);

        this.temperatureSensorService
            .getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', this.getTemperature.bind(this));

        this.services.push(this.temperatureSensorService);
    }

    if (this.showHumidity) {
        this.humiditySensorService = new Service.HumiditySensor(this.nameHumidity);

        this.humiditySensorService
            .getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .on('get', this.getHumidity.bind(this));

        this.services.push(this.humiditySensorService);
    }

    if (this.showLED) {
        this.lightBulbService = new Service.Lightbulb(this.name + ' LED');

        this.lightBulbService
            .getCharacteristic(Characteristic.On)
            .on('get', this.getLED.bind(this))
            .on('set', this.setLED.bind(this));

        this.services.push(this.lightBulbService);
    }

    this.discover();
    this.getAirInfo();
    // this.loadRoomInfo();
}

HomeClimateAirPurifier.prototype = {
    discover: function() {
        let log = console.log;
        let that = this;

        this.ws = new WebSocket(this.url);

        console.log('start connect to server')

        this.ws.on('open', function open() {

            console.log('success connect to server')

            that.loadStates()

            //start heart beat
            setInterval(function () {
                that.ws.send("{\"opType\":\"2\",\"actionParams\":\"01\"}");
            }, 1000)
        });

        this.ws.on('error', function (e) {
            log('Error in WebSocket communication, error is %s', e);
            console.log('Will retry after 30 seconds');
            setTimeout(function() {
                that.discover();
            }, 30000);
        });

        this.ws.on('message', function(msg, flags) {

            console.log('receiving data', msg);

            let data = JSON.parse(msg);
            let actionCode = data.actionCode;
            let resultCode = data.resultCode;
            if (actionCode === 'updateAd') {

            } else if (actionCode === 'updatePu') {
                // let actionResult = JSON.parse(data.jsonResults)

                if (resultCode === SUCCESS_RESULT_CODE) {
                    // let kindId = actionResult.puKindId;
                    // let modelId = actionResult.puModel;
                    // let puId = actionResult.puId;
                    let jsonDetails = JSON.parse(data.jsonResults);
                    // let _type_model_puId = kindId + "_" + modelId + "_" + puId;
                    // let type_model_puId = $("#type_model_puId").val();
                    // console.log(_type_model_puId+","+type_model_puId);

                    //更新插件UI
                    let ack = jsonDetails.actionNameAck;
                    if (ack === actionNameAck_refreshPuState) {
                        let state = jsonDetails.state;
                        if (state !== 1) {
                            console.log('设备已离线 ');
                            return;
                        }
                    }

                    that.state = {
                        accumulateWorkTime:jsonDetails.ljgzsj_state, //累计工作时间
                        airFlowRate:jsonDetails.fl_state, //风量
                        activeMode:jsonDetails.ifOpen1,//开关机状态
                        sleepMode:jsonDetails.ifOpen2,//睡眠
                        airValveMode:jsonDetails.ifOpen3,//风阀开关
                        airTemperature:jsonDetails.wd_state,//送风温度
                    }

                    // that.updateCurrentAirPurifierState();
                    that.updateActiveState(jsonDetails.ifOpen1)
                    that.updateLockPhysicalControlsState(jsonDetails.ifOpen3)
                    that.updateRotationSpeedState(jsonDetails.fl_state)
                    that.updateLEDState(jsonDetails.ifOpen2)
                    that.updateCurrentAirPurifierState(jsonDetails.ifOpen1)

                } else if (resultCode === FAIL_RESULT_CODE) {
                    console.log('数据解析回复失败');
                } else if (resultCode === SEND_SUCCESS_RESULT_CODE) {
                    //showToast('请等待');
                } else if (resultCode === PU_LOGOUT_CODE) {
                    console.log('设备已离线');
                } else if (resultCode === UNSUPPORT_PU_KIND) {
                    console.log('未知设备类型');
                } else if (resultCode === UNSUPPORT_PU_MODEL) {
                    console.log('未知设备型号');
                } else if (resultCode === UNSUPPORT_PU_ACTION_NAME) {
                    console.log('未知请求名');
                } else if (resultCode === SEND_FAIL_RESULT_CODE) {
                    console.log('数据发送失败');
                } else {
                    console.log('未知错误[' + resultCode + ']');
                }
            } else if (actionCode === 'Heart_Beat') {
                //todo nothing
            }

            // console.log('this', this.state)
            // console.log('that', that.state)
        });

        this.ws.get = function (name){
            switch (name){
                case 'LED':
                    return this.state.sleepMode
                case 'speed':
                    return this.state.airFlowRate
                case 'lock':
                    return this.state.airValveMode
                case 'power':
                    return this.state.activeMode
            }
            return this.state[name]
        }

        this.ws.set = function (name, state, cb){

            switch (name){
                case 'LED':
                    that.ws.doAction(final_318_cmd05, {"message":state.toString()}, cb)
                    break
                case 'speed':
                    that.ws.doAction(final_318_cmd03, {"message":state}, cb)
                    break
                case 'lock':
                    that.ws.doAction(final_318_cmd04, {"message":state}, cb)
                    break
                case 'power':
                    if(that.state.accumulateWorkTime > 5000){
                        console.warn("需要更新滤芯了")
                    }

                    that.ws.doAction(final_318_cmd02, {"message":state}, cb);
                    break
            }
        }

        this.ws.doAction = function (doActionName, jsonParams, cb) {
            let jsonParamsVar = JSON.stringify(jsonParams);
            jsonParamsVar = jsonParamsVar.replace("\"{", "{").replace("}\"", "}");
            let contextJson = {
                'actionName': ('\'' + doActionName + '\''),
                'actionParams': ('\'' + jsonParamsVar + '\''),
                'id': that.puId.toString(),
                'kindId': that.kindId.toString(),
                'modelId': that.model.toString()
            };

            that.ws.send(JSON.stringify(contextJson).replace(" ", ""), function (data){
                // console.log('ws send callback', data);
                setTimeout(function (){
                    !!cb && cb()
                }, 50)
            });
        }
    },

    loadStates: function(callback){
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.ws.doAction(final_318_getMainState, {}, callback)
    },

    getAirInfo: function() {
        let that = this;
        //cloudh5.51miaomiao.com/service?time=1616594775513&code=getPm25AndWeather&province=%E4%B8%8A%E6%B5%B7%E5%B8%82&city=%E4%B8%8A%E6%B5%B7%E5%B8%82

        const url = "http://cloudh5.51miaomiao.com/service?time=" + new Date().getTime() + "&code=getPm25AndWeather&province=%E4%B8%8A%E6%B5%B7%E5%B8%82&city=%E4%B8%8A%E6%B5%B7%E5%B8%82"

        const options = {
             url,
            method: 'get',
            headers: {
                'content-type': "application/json"
            }
        };

        //Send request
        axios(options, function (response) {

            console.log('air info', response.data)

            that.temperature = response.data.miotTemperature;
            that.aqi = response.data.miotAqi;
            that.pm25 = response.data.miotPM2_5;
            that.humidity = response.data.miotSD;
        }).catch(function (e){
            console.error(e, 'failed to load air info')
        })
    },

    getActiveState: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        const state = (this.state.activeMode) ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;

        this.log('getActiveState: State -> %s', state);
        callback(null, state);
    },

    setActiveState: function(state, callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log('setActiveState: %s', state);

        this.ws.set('power',state,callback);
    },

    updateActiveState: function(mode) {
        const state = mode ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;

        this.log('updateActiveState: State -> %s, Mode -> %s', state, mode);

        this.service.getCharacteristic(Characteristic.Active).updateValue(state);
    },

    getCurrentAirPurifierState: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        let that = this;

        // this.loadStates(function (){
        //     console.log("load states callback", that.state)

            const state = (that.state.activeMode === 0) ? Characteristic.CurrentAirPurifierState.INACTIVE : Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
            that.log('getCurrentAirPurifierState: State -> %s', state);
            callback(null, state);
        // });
    },

    updateCurrentAirPurifierState: function(mode) {
        const state = !mode ? Characteristic.CurrentAirPurifierState.INACTIVE : Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
        // this.state.activeMode = mode;

        this.log('updateCurrentAirPurifierState: State ->  %s', state);
        this.service.getCharacteristic(Characteristic.CurrentAirPurifierState).updateValue(state);
    },

    getTargetAirPurifierState: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        const state = (this.state.airFlowRate === 4 && this.state.sleepMode === 1) ? Characteristic.TargetAirPurifierState.AUTO : Characteristic.TargetAirPurifierState.MANUAL;
        this.log('getTargetAirPurifierState: State -> %s', state);
        callback(null, state);
    },

    setTargetAirPurifierState: function(state, callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log('setTargetAirPurifierState: %s', state);

        let that = this;
        if(state === 0){
            console.log('manual mode', this.state.airFlowRate)
            // this.ws.set('LED', this.state.sleepMode, function (){
            this.ws.set('speed',this.state.airFlowRate, callback)
            // })
        } else if (state === 1){
            console.log('auto mode', this.state.airFlowRate)
            // this.ws.set('LED', 1, function (){
            this.ws.set('speed', 4, callback)
            // })
        }
    },

    updateTargetAirPurifierState: function(mode) {
        const state = (mode !== 'favorite') ? Characteristic.TargetAirPurifierState.AUTO : Characteristic.TargetAirPurifierState.MANUAL;
        this.mode = mode;

        this.log('updateTargetAirPurifierState: Mode -> %s', mode);
        this.log('updateTargetAirPurifierState: State -> %s', state);

        this.service.getCharacteristic(Characteristic.TargetAirPurifierState).updateValue(state);
    },

    getLockPhysicalControls: async function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        const state = this.state.airValveMode ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
        this.log('getLockPhysicalControls: %s', state);
        callback(null, state);
    },

    setLockPhysicalControls: async function(state, callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log('setLockPhysicalControls: %s', state);

        this.ws.set('lock',state, callback)
    },

    updateLockPhysicalControlsState: function(mode) {
        const state = mode ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;

        this.log('updateLockPhysicalControlsState: State -> %s', state);

        this.service.getCharacteristic(Characteristic.LockPhysicalControls).updateValue(state);
    },

    getRotationSpeed: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        // console.log(this)

        const speed = this.state.airFlowRate;

        this.log('getRotationSpeed: %s', speed);

        let levels = [
            [90, 100, 8],
            [77, 89, 7],
            [64, 76, 6],
            [51, 63, 5],
            [38, 50, 4],
            [25, 37, 3],
            [12, 24, 2],
            [1, 11, 1],
            [0, 0 , 0]
        ];

        //Set fan speed based on percentage passed
        for(var item of levels){
            if(speed === item[2] ){
                callback(null,item[0]+2)
            }
        }
    },

    setRotationSpeed: function(speed, callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log('setRotationSpeed: %s', speed);

        let levels = [
            [90, 100, 8],
            [77, 89, 7],
            [64, 76, 6],
            [51, 63, 5],
            [38, 50, 4],
            [25, 37, 3],
            [12, 24, 2],
            [1, 11, 1],
            [0, 0 , 0]
        ];

        //Set fan speed based on percentage passed
        for(var item of levels){
            if(speed >= item[0] && speed <= item[1]){
                this.ws.set('speed', item[2], callback)
            }
        }
    },

    updateRotationSpeedState: function(speed) {
        let levels = [0,1,12,25,38,51,64,77,90]

        this.log('updateRotationSpeedState: Speed -> %s', levels[speed]+2);

        this.service.getCharacteristic(Characteristic.RotationSpeed).updateValue(levels[speed]+2);
    },

    getAirQuality: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log('getAirQuality: %s', this.aqi);

        for (var item of this.levels) {
            if (this.aqi >= item[0]) {
                callback(null, item[1]);
                return;
            }
        }
    },

    updateAirQuality: function(value) {
        if (!this.showAirQuality) {
            return;
        }

        this.aqi = value;
        this.log('updateAirQuality: %s', value);

        for (var item of this.levels) {
            if (value >= item[0]) {
                this.airQualitySensorService.getCharacteristic(Characteristic.AirQuality).updateValue(item[1]);
                return;
            }
        }
    },

    getPM25: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log('getPM25: %s', this.pm25);

        callback(null, this.pm25);
    },

    getTemperature: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log('getTemperature: %s', this.temperature);

        callback(null, this.temperature);
    },

    updateTemperature: function(value) {
        if (!this.showTemperature) {
            return;
        }

        this.temperature = value;
        this.log('updateTemperature: %s', value);

        this.temperatureSensorService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(value);
    },

    getHumidity: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log('getHumidity: %s', this.humidity);

        callback(null, this.humidity);
    },

    updateHumidity: function(value) {
        if (!this.showHumidity) {
            return;
        }

        this.humidity = value;
        this.log('updateHumidity: %s', value);

        this.humiditySensorService.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(value);
    },

    getLED: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        const state = this.state.sleepMode;
        this.log('getLED: %s', state);
        callback(null, state !==1);
    },

    setLED: function(state, callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }
        if (this.showLED && !this.state.activeMode){

            this.log('setLED: %s', state);

            this.ws.set('LED', state ? 1 : 0,callback);
        }
    },

    updateLEDState: function (state){
        if (this.showLED) {

            this.log('updateLEDState: %s', state);

            this.lightBulbService.getCharacteristic(Characteristic.On).updateValue(state!==1);
        }
    },

    identify: function(callback) {
        callback();
    },

    getServices: function() {
        return this.services;
    }
};
