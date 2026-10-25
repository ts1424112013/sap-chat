sap.ui.define([], function () {
        "use strict";

        var DAY = ["Calm", "Start", "Thought", "Together", "Pause", "Welcome", "Step", "Idea", "Angle", "Patience"];
        var NIGHT = ["NightRest", "NightSlow", "NightPause"];

        return {
                /** 按使用者设备的本地时段问候；首页与登录欢迎卡共用。 */
                greetingKey: function (oDate) {
                        var h = (oDate || new Date()).getHours();
                        if (h >= 5 && h < 11) { return "welcomeMorning"; }
                        if (h >= 11 && h < 13) { return "welcomeNoon"; }
                        if (h >= 13 && h < 18) { return "welcomeAfternoon"; }
                        if (h >= 18 && h < 23) { return "welcomeEvening"; }
                        return "welcomeLate";
                },

                /** 每次进入首页抽一对标题 / 副标题，排除上一对；深夜使用更舒缓的文案。 */
                pick: function (sPrevious, oDate, fnRandom) {
                        var sGreeting = this.greetingKey(oDate);
                        var aPool = sGreeting === "welcomeLate" ? NIGHT : DAY;
                        var aChoices = aPool.filter(function (s) { return s !== sPrevious; });
                        var sKey = aChoices[Math.floor((fnRandom || Math.random)() * aChoices.length)];
                        return {
                                key: sKey,
                                greetingKey: sGreeting,
                                titleKey: "heroWarm" + sKey + "Title",
                                subKey: "heroWarm" + sKey + "Sub"
                        };
                }
        };
});
