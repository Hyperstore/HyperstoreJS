﻿//	Copyright 2013 - 2014, Alain Metge. All rights reserved. 
//
//		This file is part of hyperstore (http://www.hyperstore.org)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// 
//     http://www.apache.org/licenses/LICENSE-2.0
// 
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

module Hyperstore
{
    export class Utils
    {
        private static date = new Date();
        private static sequence;

        static Requires(val, name)
        {
            if (!val)
                throw name + " is required.";
        }

        // http://stackoverflow.com/questions/7966559/how-to-convert-javascript-date-object-to-ticks
        static getUtcNow():number
        {
            // the number of .net ticks at the unix epoch
            var epochTicks = 621355968000000000;

            // there are 10000 .net ticks per millisecond
            var ticksPerMillisecond = 10000;

            // calculate the total number of .net ticks for your date
            return epochTicks + (
                Utils.date.getTime() * ticksPerMillisecond);
        }

        // Thanks to broofa & Briguy37 : http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
        static newGuid():string
        {
            var d = Utils.date.getTime();
            var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
                /[xy]/g, function (c)
                {
                    var r = (
                        d + Math.random() * 16) % 16 | 0;
                    d = Math.floor(d / 16);
                    return (
                        c === 'x'
                            ? r
                            : (
                        r & 0x7 | 0x8)).toString(16);
                }
            );
            return uuid;
        }

        static isArray(value):boolean
        {
            var s = typeof value;
            return value && typeof (
                    value) === 'object' && value instanceof Array;
        }

        static firstOrDefault(list, fn?):any
        {
            if (!list)
            {
                return;
            }

            if (list.length)
            {
                for (var i = 0; i < list.length; i++)
                {
                    var e = list[i];
                    if (e && (
                        !fn || fn(e)))
                    {
                        return e;
                    }
                }
            }
            else
            {
                for (var k in list)
                {
                    if (list.hasOwnProperty(k))
                    {
                        var e = list[k];
                        if (e && (
                            !fn || fn(e)))
                        {
                            return e;
                        }
                    }
                }
            }
            return undefined;
        }

        static forEach(list, fn)
        {
            if (!list)
            {
                return;
            }

            if (list.length)
            {
                for (var i = 0; i < list.length; i++)
                {
                    var e = list[i];
                    if (e)
                    {
                        fn(e);
                    }
                }
            }
            else
            {
                for (var k in list)
                {
                    if (list.hasOwnProperty(k))
                    {
                        var e = list[k];
                        if (e)
                        {
                            fn(e);
                        }
                    }
                }
            }
        }

        static reverse(list)
        {
            if (!list)
            {
                return undefined;
            }

            var list2 = [];
            0
            if (list.length)
            {
                for (var i = list.length - 1; i >= 0; i--)
                {
                    var e = list[i];
                    if (e)
                    {
                        list2.push(e);
                    }
                }
            }
            else
            {
                for (var k in list)
                {
                    if (list.hasOwnProperty(k))
                    {
                        var e = list[k];
                        if (e)
                        {
                            list2.unshift(e);
                        }
                    }
                }
            }
            return list2;
        }

        static where(list, fn)
        {
            var list2 = [];
            Utils.forEach(
                list, e=>
                {
                    if (fn(e))
                    {
                        list2.push(e);
                    }
                }
            );
            return list2;
        }

        static indexOf(list, fn):number
        {
            var ix = -1;
            Utils.forEach(
                list, e=>
                {
                    ix++;
                    var r = fn(e);
                    if (r)
                    {
                        return ix;
                    }
                }
            );
            return -1;
        }

        static select(list, fn)
        {
            var list2 = [];
            Utils.forEach(
                list, e=>
                {
                    var r = fn(e);
                    if (r)
                    {
                        list2.push(r);
                    }
                }
            );
            return list2;
        }

        static selectMany(list, fn)
        {
            var list2 = [];
            Utils.forEach(
                list, e=>
                {
                    var r = fn(e);
                    Utils.forEach(
                        r, e2 =>
                        {
                            list2.push(e2);
                        }
                    );
                }
            );
            return list2;
        }

        static groupBy(list, fn)
        {
            var list2 = {};
            Utils.forEach(
                list, e=>
                {
                    var key = fn(e);
                    var tmp = list2[key];
                    if (!tmp)
                    {
                        tmp = {key: key, value: []}
                        list2[key] = tmp;
                    }

                    tmp.value.push(e);
                }
            );
            return list2;
        }
    }
}