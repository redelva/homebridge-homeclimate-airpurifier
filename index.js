var WebSocket = require('ws');
var axios = require("axios");
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

    //1616594775042
    this.url = "ws://cloudh5.51miaomiao.com/servlet/SwapDataServlet?cuId=" + this.cuId + "~" + this.puId + "~" + this.token + "~" + this.model + "~1616594775042";

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
        airFlowRate:0, //风量
        activeMode:0,//开关机状态
        sleepMode:0,//睡眠
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

    // this.service
    //     .getCharacteristic(Characteristic.LockPhysicalControls)
    //     .on('get', this.getLockPhysicalControls.bind(this))
    //     .on('set', this.setLockPhysicalControls.bind(this));

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
}

HomeClimateAirPurifier.prototype = {
    discover: function() {
        let log = this.log;
        let that = this;

        this.ws = new WebSocket(this.url);

        this.ws.on('open', function() {
            //start heart beat
            setInterval(function () {
                that.ws.send("{\"opType\":\"2\",\"actionParams\":\"01\"}");

                that.ws.loadState()
            }, 1000)
        })

        this.ws.on('error', function (e) {
            log('Error in WebSocket communication, error is %s', e);
            console.log('Will retry after 30 seconds');
            setTimeout(function() {
                that.discover();
            }, 30000);
        });

        this.ws.on('message', function(msg, flags) {
            // {"actionCode":"updatePu","id":0,"jsonResults":"{\"wd_state\":21,\"fl_state\":0,\"ljgzsj_state\":6,\"state\":0,\"ifOpen3\":0,\"ifOpen2\":1,\"ifOpen1\":0}","location":"上海市","puFactoryID":0,"puId":213444,"puKindId":300,"puModel":318,"puName":"家环境新鲜空气机","resultCode":1,"resultCodeInfo":""}
            let data = JSON.parse(msg);
            let actionCode = data.actionCode;
            if (actionCode === 'updateAd') {

            } else if (actionCode === 'updatePu') {
                that.ws.parseState(data);
            } else if (actionCode === 'Heart_Beat') {
                //todo nothing
            }
        });

        this.ws.getLED = async function(){
            return this.state.sleepMode
        }

        this.ws.setLED = function(state, cb){
            if (state === 0) {
                that.ws.doAction(final_318_cmd05, {"message":"1"}, cb);
            } else if (state === 1) {
                that.ws.doAction(final_318_cmd05, {"message":"0"}, cb);
            }
        }

        this.ws.getSpeed = function(){
            return this.state.airFlowRate
        }

        this.ws.setSpeed = function(speed, cb){
            // doAction(final_318_cmd03, '{\"message\":\"' + speedValue + '\"}');
            that.ws.doAction(final_318_cmd03, {"message":speed}, cb)
        }

        this.ws.getPower = function(){
            return this.state.activeMode
        }

        this.ws.setPower = async function(state, cb){
            function powerOn(cb) {
                if(that.state.accumulateWorkTime < 5000){
                    that.ws.doAction(final_318_cmd02, '{"message":1}', cb);
                }else{
                    console.warn("需要更新滤芯了")
                }
            }

            function powerOff(cb) {
                that.ws.doAction(final_318_cmd02, '{"message":0}', cb);
            }

            if(state === 0 ){
                powerOff(cb)
            }else{
                powerOn(cb)
            }
        }

        this.ws.loadState = function(){
            that.ws.doAction(final_318_getMainState, {})
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

            that.ws.send(JSON.stringify(contextJson).replace(" ", ""));
            !!cb && cb()
        }

        this.ws.parseState= function(actionResult){
            let resultCode = actionResult.resultCode;
            if (resultCode === SUCCESS_RESULT_CODE) {
                // let kindId = actionResult.puKindId;
                // let modelId = actionResult.puModel;
                // let puId = actionResult.puId;
                let jsonDetails = JSON.parse(actionResult.jsonResults);
                // let _type_model_puId = kindId + "_" + modelId + "_" + puId;
                // let type_model_puId = $("#type_model_puId").val();
                // console.log(_type_model_puId+","+type_model_puId);

                //更新插件UI
                let ack = jsonDetails.actionNameAck;
                if (ack === actionNameAck_refreshPuState) {
                    let state = jsonDetails.state;
                    if(state !== 1){
                        console.log('设备已离线 ');
                        return;
                    }

                    this.state = {
                        accumulateWorkTime:jsonDetails.ljgzsj_state, //累计工作时间
                        airFlowRate:jsonDetails.fl_state, //风量
                        activeMode:jsonDetails.ifOpen1,//开关机状态
                        sleepMode:jsonDetails.ifOpen1,//睡眠
                        airValveMode:jsonDetails.ifOpen3,//风阀开关
                        airTemperature:jsonDetails.wd_state,//送风温度
                    }
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
            }
        }
    },

    getAirInfo: function() {
        //cloudh5.51miaomiao.com/service?time=1616594775513&code=getPm25AndWeather&province=%E4%B8%8A%E6%B5%B7%E5%B8%82&city=%E4%B8%8A%E6%B5%B7%E5%B8%82

        const url = "http://cloudh5.51miaomiao.com/service?time=1616594775513&code=getPm25AndWeather&province=%E4%B8%8A%E6%B5%B7%E5%B8%82&city=%E4%B8%8A%E6%B5%B7%E5%B8%82"

        const options = {
            url,
            method: 'get',
            headers: {
                'content-type': "application/json"
            }
        };

        let that = this;

        //Send request
        axios(options, function (response) {
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

        this.log.debug('getActiveState: Mode -> %s', this.mode);
        this.log.debug('getActiveState: State -> %s', state);
        callback(null, state);
    },

    setActiveState: function(state, callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log.debug('setActiveState: %s', state);

        this.ws.setPower(state,callback);
    },

    updateActiveState: function(mode) {
        const state = (this.state.activeMode !== 'idle') ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
        this.state.activeMode = mode;

        this.log.debug('updateActiveState: Mode -> %s', mode);
        this.log.debug('updateActiveState: State -> %s', state);

        this.service.getCharacteristic(Characteristic.Active).updateValue(state);
    },

    getCurrentAirPurifierState: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        const state = (this.state.activeMode === 'idle') ? Characteristic.CurrentAirPurifierState.INACTIVE : Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
        this.log.debug('getCurrentAirPurifierState: Mode -> %s', this.state);
        this.log.debug('getCurrentAirPurifierState: State -> %s', state);
        callback(null, state);
    },

    updateCurrentAirPurifierState: function(mode) {
        const state = (mode === 'idle') ? Characteristic.CurrentAirPurifierState.INACTIVE : Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
        this.state.activeMode = mode;

        this.log.debug('updateCurrentAirPurifierState: Mode ->  %s', mode);
        this.log.debug('updateCurrentAirPurifierState: State ->  %s', state);
        this.service.getCharacteristic(Characteristic.CurrentAirPurifierState).updateValue(state);
    },

    getTargetAirPurifierState: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        const state = (this.state.airFlowRate === 4 && this.state.sleepMode === 1) ? Characteristic.TargetAirPurifierState.AUTO : Characteristic.TargetAirPurifierState.MANUAL;
        this.log.debug('getTargetAirPurifierState: Mode -> %s', this.state);
        this.log.debug('getTargetAirPurifierState: State -> %s', state);
        callback(null, state);
    },

    setTargetAirPurifierState: function(state, callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log.debug('setTargetAirPurifierState: %s', state === 0 ? 'manual' : 'auto');

        if(state === 0){
            // this.targetPurifierState = 'manual';
            this.setLED(this.state.sleepMode, function (){
                this.setRotationSpeed(this.state.airFlowRate, callback)
            })
        } else if (state === 1){
            // this.targetPurifierState = 'auto';
            this.setLED(1, function (){
                this.setRotationSpeed(4, callback)
            })
        }
    },

    updateTargetAirPurifierState: function(mode) {
        const state = (mode !== 'favorite') ? Characteristic.TargetAirPurifierState.AUTO : Characteristic.TargetAirPurifierState.MANUAL;
        this.mode = mode;

        this.log.debug('updateTargetAirPurifierState: Mode -> %s', mode);
        this.log.debug('updateTargetAirPurifierState: State -> %s', state);

        this.service.getCharacteristic(Characteristic.TargetAirPurifierState).updateValue(state);
    },

    // getLockPhysicalControls: async function(callback) {
    //     if (!this.ws) {
    //         callback(new Error('No Air Purifier is discovered.'));
    //         return;
    //     }
    //
    //     await this.ws.call('get_prop', ['child_lock'])
    //         .then(result => {
    //             const state = (result[0] === 'on') ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
    //             this.log.debug('getLockPhysicalControls: %s', state);
    //             callback(null, state);
    //         })
    //         .catch(err => callback(err));
    // },
    //
    // setLockPhysicalControls: async function(state, callback) {
    //     if (!this.ws) {
    //         callback(new Error('No Air Purifier is discovered.'));
    //         return;
    //     }
    //
    //     this.log.debug('setLockPhysicalControls: %s', state);
    //
    //     await this.ws.call('set_child_lock', [(state) ? 'on' : 'off'])
    //         .then(result => {
    //             (result[0] === 'ok') ? callback(): callback(new Error(result[0]));
    //         })
    //         .catch(err => callback(err));
    // },

    getRotationSpeed: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        const speed = this.ws.getSpeed();

        callback(null, speed)

        // this.device.favoriteLevel()
        //     .then(level => {
        //         const speed = Math.ceil(level * 6.25);
        //         this.log.debug('getRotationSpeed: %s', speed);
        //         callback(null, speed);
        //     })
        //     .catch(err => callback(err));
    },

    setRotationSpeed: function(speed, callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.ws.setSpeed(speed, callback)

        // // Overwrite to manual mode
        // if (this.mode != 'favorite') {
        //     this.device.setMode('favorite')
        //         .then()
        //         .catch(err => callback(err));
        // }
        //
        // // Set favorite level
        // const level = Math.ceil(speed / 6.25);
        //
        // this.log.debug('setRotationSpeed: %s', level);
        //
        // this.device.setFavoriteLevel(level)
        //     .then(mode => callback(null))
        //     .catch(err => callback(err));
    },

    getAirQuality: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log.debug('getAirQuality: %s', this.aqi);

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
        this.log.debug('updateAirQuality: %s', value);

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

        this.log.debug('getPM25: %s', this.pm25);

        callback(null, this.pm25);
    },

    getTemperature: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log.debug('getTemperature: %s', this.temperature);

        callback(null, this.temperature);
    },

    updateTemperature: function(value) {
        if (!this.showTemperature) {
            return;
        }

        this.temperature = value;
        this.log.debug('updateTemperature: %s', value);

        this.temperatureSensorService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(value);
    },

    getHumidity: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log.debug('getHumidity: %s', this.humidity);

        callback(null, this.humidity);
    },

    updateHumidity: function(value) {
        if (!this.showHumidity) {
            return;
        }

        this.humidity = value;
        this.log.debug('updateHumidity: %s', value);

        this.humiditySensorService.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(value);
    },

    getLED: function(callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        const state = this.ws.getLED();
        this.log.debug('getLED: %s', state);
        callback(null, state);
    },

    setLED: function(state, callback) {
        if (!this.ws) {
            callback(new Error('No Air Purifier is discovered.'));
            return;
        }

        this.log.debug('setLED: %s', state);

        this.ws.setLED(state, callback);
    },

    identify: function(callback) {
        callback();
    },

    getServices: function() {
        return this.services;
    }
};
