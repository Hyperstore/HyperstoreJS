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
    // ---------------------------------------------------------------------------------------------
    // store is the main hyperstore container for domains and schemas.
    // It can contains many domains and schemas and supports references between domains.
    // Every change made on a domain must be in a session which works like an unit of work. When the session is closed, constraints are check on every 
    // involved elements generating potential diagnostic messages. Then events representing all changes made during the session are raised.
    //
    //    var session = store.beginSession(); // Start a session
    //    try {
    //      ... adds, removes or changes actions
    //      session.acceptChanges(); // commit all changes
    //    }
    //    finally {
    //      session.close();   // abort or commit changes and send events
    //    }
    //
    export class Store
    {
        private schemasBySimpleName;
        private schemas;
        private _domains:Array<DomainModel>;
        private _subscriptions:Array<(s:Session) => any>;

        // event bus 
        public eventBus:EventBus;

        // ------------------------------------------------------------------------------------------------------
        // create a new store. You can create many independent store. They can communicate between them with the eventBus.
        // ------------------------------------------------------------------------------------------------------
        constructor(public storeId?:string)
        {
            this._subscriptions = [];
            this.eventBus = new EventBus(this);
            this.schemas = {};
            this.schemasBySimpleName = {};
            this._domains = new Array<DomainModel>();

            if (storeId !== undefined)
            {
                this.storeId = storeId;
            }
            else
            {
                this.storeId = Utils.newGuid();
            }
            new Schema(this, "$", this.primitiveSchemaDefinition());
        }

        dispose()
        {
            this.eventBus.dispose();
            this.eventBus = undefined;
            this.domains.forEach(d=> d.dispose());
            this._domains = undefined;
            this.schemas = undefined;
            this.schemasBySimpleName = undefined;
            this._subscriptions = undefined;
        }

        public unloadDomain(domain:DomainModel)
        {
            domain.dispose();
            var pos = this._domains.indexOf(domain);
            this._domains.splice(pos);
        }

        // ------------------------------------------------------------------------------------------------------
        // Get the list of loaded domains
        // ------------------------------------------------------------------------------------------------------
        public get domains():Queryable<DomainModel>
        {
            return new Queryable<DomainModel>(this._domains);
        }

        // ------------------------------------------------------------------------------------------------------
        // Subscribe to session completed event. This event is always raise even if the session is aborted.
        // Returns a cookie used to unsubscribe to this event
        // ------------------------------------------------------------------------------------------------------
        subscribeSessionCompleted(action:(s:Session) => any):number
        {
            return this._subscriptions.push(action);
        }

        // ------------------------------------------------------------------------------------------------------
        // Unsubscribe to session completed event. Cookie is provided by the subscribe function.
        // ------------------------------------------------------------------------------------------------------
        unsubscribeSessionCompleted(cookie:number)
        {
            this._subscriptions.splice(cookie);
        }

        // ------------------------------------------------------------------------------------------------------
        // internal use only
        // ------------------------------------------------------------------------------------------------------
        __sendSessionCompletedEvent(session:Session)
        {
            this._subscriptions.forEach(fn=> fn(session));
        }

        private primitiveSchemaDefinition()
        {
            return {
                defineSchema: function (schema)
                {
                    new Primitive(schema, "string");
                    new Primitive(schema, "number");
                    new Primitive(schema, "date");
                    new Primitive(schema, "bool");
                }
            };
        }

        // ------------------------------------------------------------------------------------------------------
        // get a loaded domain by name or undefined if not exists
        // ------------------------------------------------------------------------------------------------------
        getDomain(name:string):DomainModel
        {
            for (var i = 0; i < this._domains.length; i++)
            {
                var d = this._domains[i];
                if (d.name === name)
                {
                    return d;
                }
            }
            return undefined;
        }

        __addDomain(domain:DomainModel)
        {
            this._domains.push(domain);
        }

        // ------------------------------------------------------------------------------------------------------
        // begin a new session with optional configuration.
        // if a session already exist a nested session is created.
        // sessions are flatten, if your abort the top level session or any of a nested session, the top level session will be aborted.
        //  session configurations can be :
        //   - defaultDomain : if you create a new element during this session with no domain specified, the default domain will be use.
        //   
        // ------------------------------------------------------------------------------------------------------
        public beginSession(config?:SessionConfiguration):Session
        {
            if (Session.current === undefined)
            {
                Session.current = new Session(this, config);
            }
            else
            {
                Session.current.__nextLevel();
            }

            return Session.current;
        }

        // ------------------------------------------------------------------------------------------------------
        // internal use only
        // ------------------------------------------------------------------------------------------------------
        public __addSchemaElement(schemaInfo:SchemaInfo)
        {
            var id = schemaInfo.id.toLowerCase();
            if (this.schemas[id])
            {
                throw "Duplicate schema " + schemaInfo.id;
            }

            this.schemas[id] = schemaInfo;
            var pos = id.indexOf(':');
            var simpleName = pos < 0 ? id : id.substr(pos + 1);

            if (!this.schemasBySimpleName[simpleName])
            {
                this.schemasBySimpleName[simpleName] = schemaInfo;
            }
            else
            {
                this.schemasBySimpleName[simpleName] = null; // duplicate
            }

            if (schemaInfo.kind === SchemaKind.Relationship)
            {
                var rel = <SchemaRelationship>schemaInfo;
                if (rel.startProperty !== undefined)
                {
                    var source = <SchemaElement>this.getSchemaElement(rel.startSchemaId);
                    source.__defineReferenceProperty(rel, false);
                }
                if (rel.endProperty !== undefined)
                {
                    var source = <SchemaElement>this.getSchemaElement(rel.endSchemaId);
                    source.__defineReferenceProperty(rel, true);
                }
            }
        }

        // ------------------------------------------------------------------------------------------------------
        // get a schema info by name. By default, an exception is thrown if no schema exists
        // ------------------------------------------------------------------------------------------------------
        public getSchemaInfo(schemaName:string, throwException:boolean = true):SchemaInfo
        {
            var schemaElement;
            if (schemaName.indexOf(':') < 0)
            {
                schemaElement = this.schemasBySimpleName[schemaName.toLowerCase()];
                if (schemaElement === null)
                {
                    throw "Can not resolve schema element by its simple name due to duplicate elements. Use full name to resolve this schema element.";
                }
            }
            else
            {
                schemaElement = this.schemas[schemaName.toLowerCase()];
            }

            if (!schemaElement && throwException)
            {
                throw "Unknown schema " + schemaName;
            }

            return schemaElement;
        }

        public getSchemaRelationships(start?:any, end?:any):Queryable<SchemaRelationship>
        {
            if (typeof (start) === "string")
            {
                start = this.getSchemaElement(<string>start);
            }
            if (typeof (end) === "string")
            {
                end = this.getSchemaElement(<string>end);
            }

            var list = [];
            this.schemas.forEach(v=>
            {
                if (v.kind === SchemaKind.Relationship)
                {
                    var r = <SchemaRelationship>v;
                    if ((!start || r.startSchemaId === start.id) && (!end || r.endSchemaId === end.id))
                    {
                        list.push(r);
                    }
                }
            });

            return new Queryable<SchemaRelationship>(list);
        }

        // ------------------------------------------------------------------------------------------------------
        // get a schema element by name. A schema element can be a schemaEntity or a schemaRelationship
        // By default, an exception is thrown if no schema exists
        // ------------------------------------------------------------------------------------------------------
        public getSchemaElement(schemaName:string, throwException:boolean = true):SchemaElement
        {
            var schemaElement = this.getSchemaInfo(schemaName, throwException);
            if ((schemaElement.kind !== SchemaKind.Relationship && schemaElement.kind !== SchemaKind.Entity) && throwException)
            {
                throw "Unknown schema " + schemaName;
            }

            return <SchemaElement>schemaElement;
        }

        // ------------------------------------------------------------------------------------------------------
        // get a schema relationship by name. By default, an exception is thrown if no schema exists
        // ------------------------------------------------------------------------------------------------------
        public getSchemaRelationship(schemaName:string, throwException:boolean = true):SchemaRelationship
        {
            var schemaElement = this.getSchemaInfo(schemaName, throwException);
            if ((schemaElement.kind !== SchemaKind.Relationship) && throwException)
            {
                throw "Unknown schema " + schemaName;
            }

            return <SchemaRelationship>schemaElement;
        }

        // ------------------------------------------------------------------------------------------------------
        // get a schema entity by name. By default, an exception is thrown if no schema exists
        // ------------------------------------------------------------------------------------------------------
        public getSchemaEntity(schemaName:string, throwException:boolean = true):SchemaEntity
        {
            var schemaElement = this.getSchemaInfo(schemaName, throwException);
            if ((schemaElement.kind !== SchemaKind.Entity) && throwException)
            {
                throw "Unknown schema " + schemaName;
            }

            return <SchemaEntity>schemaElement;
        }

        // ------------------------------------------------------------------------------------------------------
        // shortcut to execute an action in a session
        // ------------------------------------------------------------------------------------------------------
        public runInSession(action:() => void)
        {
            var session = this.beginSession();
            try
            {
                action();
                Session.current.acceptChanges();
            }
            finally
            {
                session.close();
            }
        }

        // ------------------------------------------------------------------------------------------------------
        // get an element by id 
        // ------------------------------------------------------------------------------------------------------
        getElement(id:string):ModelElement
        {
            for (var i = 0; i < this._domains.length; i++)
            {
                var mel = this._domains[i].getElement(id);
                if (!mel)
                {
                    return mel;
                }
            }
            return undefined;
        }

        // ------------------------------------------------------------------------------------------------------
        // get a list of elements
        // ------------------------------------------------------------------------------------------------------
        getElements(schemaElement?:SchemaElement, kind:NodeType = NodeType.EdgeOrNode):Queryable<ModelElement>
        {
            return new Queryable<ModelElement>(this.domains.selectMany(function (domain)
            {
                return domain.GetElements(schemaElement, kind);
            }));
        }
    }

    // =============================================
    // Domain model
    // =============================================

    /**
     * Represents a domain model
     */
    export class DomainModel
    {
        private _sequence = 0;
        public events:EventManager;
        private _cache:{};
        public eventDispatcher:IEventDispatcher;
        private _adapters:Adapter[];

        private _graph:Hypergraph;

        /**
         * Domain model constructor
         * @param store : the store the domain belong to
         * @param name : domain name
         * @param extension : extension name
         */
        constructor(public store:Store, public name:string, public extension?:string)
        {
            this._graph = new Hypergraph(this);
            store.__addDomain(this);
            this.events = new EventManager(this.name);
            this._cache = {};
            this._adapters = [];
            this.name = this.name.toLowerCase();
        }

        dispose()
        {
            Utils.forEach(this._adapters, a=> a.dispose());

            this._graph.dispose();
            this._graph = undefined;
            this.events.dispose();
            this.events = undefined;
            this._cache = undefined;
            this.eventDispatcher = undefined;
        }

        /**
         * create a new unique id for this domain.
         * An id is composed by two parts (the domain name and a unique id) separated by ':'
         * @param id - optional id. If not provided a new id will be generated
         * @returns {string} A domain id
         */
        createId(id?:string):string
        {
            var n = parseInt(id);
            if (!isNaN(n) && n > this._sequence)
            {
                this._sequence = n;
            }

            return this.name + ":" + (id || ++this._sequence).toString();
        }

        addAdapterAsync(adapter:Adapter):JQueryPromise<any>
        {
            var self = this;
            return adapter.initAsync(this).then(function (a)
            {
                self._adapters.push(a);
                return a;
            });
        }

        /**
         *  Find a schema element by its id in the json compressed data
         * @param schemas - list of schema id from the json
         * @param id - index of the schema
         * @returns {any} - a valid schema id
         */
        private findSchemaId(schemas, id):string
        {
            if (schemas != undefined)
            {
                for (var k in schemas)
                {
                    var schema = schemas[k];
                    for (var ke in schema.elements)
                    {
                        var e = schema.elements[ke];
                        if (e.id === id)
                        {
                            var schemaId;
                            if ( schema.name == null) // null or undefined
                            {
                                schemaId = e.name;
                            }
                            else
                            {
                                schemaId = schema.name + ":" + e.name;
                            }

                            return schemaId;
                        }
                    }
                }
            }
            return id;
        }

        // ------------------------------------------------------------------------------------------------------
        // Load a domain from a json object. This object can have two specific format:
        //   - hyperstore format. (generated by the hyperstore serializer)
        //   - a poco object. For circular references, the newtonwsoft format is used ($id and $ref) (http://james.newtonking.com/json/help/html/T_Newtonsoft_Json_PreserveReferencesHandling.htm)
        // ------------------------------------------------------------------------------------------------------
        loadFromJson(def:any, rootSchema?:SchemaElement):Queryable<ModelElement>
        {
            if (!def)
            {
                return;
            }

            if (def.entities || def.relationships)
            {
                this.loadFromHyperstoreJson(def);
                return;
            }

            if (!rootSchema)
            {
                throw "rootSchema is required";
            }
            var refs = {};
            if (Utils.isArray(def))
            {
                var list = [];
                Utils.forEach(def, e => list.push(this.parseJson(e, rootSchema, refs)));
                return new Queryable<ModelElement>(list);
            }
            else
            {
                return new Queryable<ModelElement>(this.parseJson(def, rootSchema, refs));
            }
        }

        private parseJson(obj:any, schema:SchemaElement, refs):ModelElement
        {
            var mel = this.createEntity(schema);
            for (var member in obj)
            {
                var val = obj[member];
                var prop = mel.schemaElement.getProperty(member, true);
                if (prop)
                {
                    mel.setPropertyValue(prop, prop.deserialize(new SerializationContext(this, mel.id, undefined, undefined, undefined, undefined, val)));
                    continue;
                }

                var rel = mel.schemaElement.getReference(member, true);
                if (rel)
                {
                    var endSchema = this.store.getSchemaEntity(rel.schemaRelationship.endSchemaId);
                    var values = val;
                    if (Utils.isArray(val))
                    {
                        if (!rel.isCollection)
                        {
                            throw "Property " + member + " must be a collection";
                        }
                    }
                    else
                    {
                        values = [val];
                        if (rel.isCollection)
                        {
                            throw "Property " + member + " must not be a collection";
                        }
                    }

                    for (var i in values)
                    {
                        var v = values[i];
                        var elem:ModelElement;
                        if (v.$ref)
                        {
                            elem = refs[v.$ref];
                        }
                        else
                        {
                            elem = this.parseJson(v, endSchema, refs);
                        }

                        var src = rel.opposite
                            ? elem
                            : mel;
                        var end = rel.opposite
                            ? mel
                            : elem;

                        if (src.domain.getRelationships(rel.schemaRelationship, src, end).count === 0)
                        {
                            src.domain.createRelationship(rel.schemaRelationship, src, end.id, end.schemaElement.id);
                        }

                        if (v.$id)
                        {
                            refs[v.$id] = elem;
                        }

                    }
                }
            }
            return mel;
        }

        private loadFromHyperstoreJson(def):Array<ModelElement>
        {
            var list = [];
            var session = this.store.beginSession();
            try
            {
                for (var k = 0; k < def.entities.length; k++)
                {
                    var entity = def.entities[k];
                    var entityId = this.createId(entity["id"]);
                    if (entity.state && entity.state === "D")
                    {
                        this.removeElement(entityId, entity.v);
                        continue;
                    }

                    var elem;
                    var schemaId = this.findSchemaId(def.schemas, entity["schema"]);
                    var schema = this.store.getSchemaElement(schemaId);
                    if (!this.elementExists(entityId))
                    {
                        list.push(elem = this.createEntity(schema, entityId));
                    }

                    if (entity.properties != undefined)
                    {
                        for (var kprop in entity.properties)
                        {
                            var prop = entity.properties[kprop];
                            var propDef = schema.getProperty(<string>prop.name, true);
                            if (propDef != null)
                            {
                                var v = prop.value;
                                this.setPropertyValue(entityId, propDef, v);
                            }
                        }
                    }
                }

                if (def.relationships != undefined)
                {
                    for (var k = 0; k < def.relationships.length; k++)
                    {
                        var relationship = def.relationships[k];
                        var entityId = this.createId(relationship["id"]);
                        if (relationship.state && relationship.state === "D")
                        {
                            this.removeElement(entityId, relationship.v);
                            continue;
                        }

                        var schemaId = this.findSchemaId(def.schemas, relationship["schema"]);
                        var schema = this.store.getSchemaElement(schemaId);

                        if (!this.elementExists(entityId))
                        {
                            var start = this.getElement(this.createId(relationship.startId));
                            this.createRelationship(<SchemaRelationship>schema, start, this.createId(relationship.endId), this.findSchemaId(def.schemas, relationship.endSchemaId), entityId);
                        }

                        if (relationship.properties != undefined)
                        {
                            for (var kprop in relationship.properties)
                            {
                                var prop = relationship.properties[kprop];
                                var propDef = schema.getProperty(<string>prop.name, true);
                                if (propDef != null)
                                {
                                    var v = prop.value;
                                    this.setPropertyValue(entityId, propDef, v);
                                }
                            }
                        }
                    }
                }
                session.acceptChanges();
            }
            finally
            {
                session.close();
            }
            return list;
        }

        // ------------------------------------------------------------------------------------------------------
        // Get relationships of the domain filtered by schema or terminal elements.
        //  schemaElement : Select only relationships of this schema (including inheritance)  
        //  start : Select outgoing relationships of 'start'
        //  end : Select incoming relationships of 'end'
        // Filters can be combined.
        // ------------------------------------------------------------------------------------------------------
        getRelationships(schemaElement?:SchemaRelationship, start?:ModelElement, end?:ModelElement):Queryable<ModelElement>
        {
            var list = [];
            var currentSchema = <SchemaElement>schemaElement;
            var tmpSchema = currentSchema;

            if (start != undefined)
            {
                var node = this._graph.getNode(start.id);
                if (node != undefined)
                {
                    for (var relid in node.outgoings)
                    {
                        var info = <EdgeInfo>node.outgoings[relid];
                        if (end && end.id !== info.endId)
                        {
                            continue;
                        }

                        tmpSchema = currentSchema;
                        if (schemaElement  && schemaElement.id !== tmpSchema.id)
                        {
                            tmpSchema = this.store.getSchemaElement(info.schemaId);
                            if (!tmpSchema.isA(schemaElement.id))
                            {
                                continue;
                            }
                        }
                        var rel = this.getFromCache(tmpSchema, start.id, start.schemaElement.id, info.endId, info.endSchemaId, info.id);
                        list.push(rel);
                    }
                }
                return new Queryable<ModelElement>(list);
            }
            else if (end != undefined)
            {
                var node = this._graph.getNode(end.id);
                if (node != undefined)
                {
                    for (var relid in node.incomings)
                    {
                        var info = <EdgeInfo>node.incomings[relid];
                        tmpSchema = currentSchema;
                        if (schemaElement  && schemaElement.id !== tmpSchema.id)
                        {
                            tmpSchema = this.store.getSchemaElement(info.schemaId);
                            if (!tmpSchema.isA(schemaElement.id))
                            {
                                continue;
                            }
                        }
                        var rel = this.getFromCache(tmpSchema, info.endId, info.endSchemaId, end.id, end.schemaElement.id, info.id);
                        list.push(rel);
                    }
                }
                return new Queryable<ModelElement>(list);
            }
            else
            {
                return new Queryable<ModelElement>(Utils.select(this._graph.getNodes(NodeType.Edge, schemaElement),
                        n=>
                    {
                        tmpSchema = currentSchema;
                        if (schemaElement  && schemaElement.id !== tmpSchema.id)
                        {
                            tmpSchema = this.store.getSchemaElement(info.schemaId);
                            if (tmpSchema.isA(schemaElement.id))
                            {
                                return this.getFromCache(tmpSchema, n.startId, n.startSchemaId, n.endId, n.endSchemaId, n.id);
                            }
                        }
                        return undefined;
                    }));
            }
        }

        // ------------------------------------------------------------------------------------------------------
        // get value of an element property in the underlying hypergraph.
        // Returns 'undefined' if the value doesn't exist and no defaultValue is set in the property schema.
        // Otherwise, returns a PropertyValue {value, version}
        // ------------------------------------------------------------------------------------------------------
        getPropertyValue(ownerId:string, property:SchemaProperty):PropertyValue
        {
            if (!this._graph.getNode(ownerId))
            {
                throw "Invalid element " + ownerId;
            }

            var pid = ownerId + property.name;
            var node = this._graph.getNode(pid);
            var value = undefined;

            if (!node)
            {
                var def = property.defaultValue;
                if (!def)
                {
                    return undefined;
                }
                return new PropertyValue(typeof def == typeof function () { } // TODO revoir test
                    ? def()
                    : def, undefined, 0);
            }

            return new PropertyValue(node.value, undefined, node.version);
        }

        // ------------------------------------------------------------------------------------------------------
        // set value of an element property
        // Returns a PropertyValue {value, oldValue, version}
        // ------------------------------------------------------------------------------------------------------
        setPropertyValue(ownerId:string, property:SchemaProperty, value:any, version?:number):PropertyValue
        {
            var ownerNode = this._graph.getNode(ownerId);
            if (!ownerNode)
            {
                throw "Invalid element " + ownerId;
            }

            var pid = ownerId + property.name;
            var node = this._graph.getNode(pid);
            var oldValue = undefined;

            if (!node)
            {
                node = this._graph.addPropertyNode(pid, property.schemaProperty.id, value, version);
            }
            else
            {
                oldValue = node.value;
                node.value = value;
                node.version = version || Utils.getUtcNow();
            }
            var pv = new PropertyValue(value, oldValue, node.version);

            this.store.runInSession(() => Session.current.addEvent(
                new ChangePropertyValueEvent(this.name,
                    ownerId,
                    ownerNode.schemaId,
                    property.name,
                    property.serialize(pv.value),
                    property.serialize(pv.oldValue),
                    Session.current.sessionId,
                    pv.version)
            ));
            return pv;
        }

        private updateSequence(id:string)
        {
            if (!id)
            {
                return;
            }
            var key = id.substr(this.name.length + 1);
            var n = parseInt(key);
            if (n != NaN && n > this._sequence)
            {
                this._sequence = n;
            }
        }

        // ------------------------------------------------------------------------------------------------------
        // create a new domain entity using the specified schema
        // ------------------------------------------------------------------------------------------------------
        createEntity(schemaElement:SchemaElement, id?:string, version?:number):ModelElement
        {
            var mel = schemaElement.deserialize(new SerializationContext(this, id));
            this.updateSequence(id);
            var node = this._graph.addNode(mel.id, schemaElement.id, version);
            this.store.runInSession(() => Session.current.addEvent(new AddEntityEvent(this.name, mel.id, schemaElement.id, Session.current.sessionId, node.version)));
            this._cache[mel.id] = mel;
            return mel;
        }

        // ------------------------------------------------------------------------------------------------------
        // create a new domain relationship using the specified schema
        // ------------------------------------------------------------------------------------------------------
        createRelationship(schemaElement:SchemaRelationship, start:ModelElement, endId:string, endSchemaId:string, id?:string, version?:number):ModelElement
        {
            this.updateSequence(id);
            var mel = schemaElement.deserialize(new SerializationContext(this, id, start.id, start.schemaElement.id, endId, endSchemaId));
            var node = this._graph.addRelationship(mel.id, schemaElement.id, start.id, start.schemaElement.id, endId, endSchemaId, version);
            this.store.runInSession(() => Session.current.addEvent(new AddRelationshipEvent(this.name, mel.id, schemaElement.id, start.id, start.schemaElement.id, endId, endSchemaId, Session.current.sessionId, node.version)));
            this._cache[mel.id] = mel;
            return mel;
        }

        // ------------------------------------------------------------------------------------------------------
        // remove an element (entity or relationship)
        // ------------------------------------------------------------------------------------------------------
        removeElement(id:string, version?:number)
        {
            var events;
            this.store.runInSession(() =>
            {
                events = this._graph.removeNode(id, version);
                Utils.forEach(events, e=> Session.current.events.push(e));
            });

            events.forEach(e =>
            {
                var mel = this._cache[e.id];
                mel.dispose();
                delete mel;
            });
        }

        // ------------------------------------------------------------------------------------------------------
        // check if an element (entity or relationship) exists
        // ------------------------------------------------------------------------------------------------------
        elementExists(id:string):boolean
        {
            return this._graph.getNode(id) != undefined;
        }

        // ------------------------------------------------------------------------------------------------------
        // get an element (entity or relationship) by its id
        // ------------------------------------------------------------------------------------------------------
        getElement(id:string):ModelElement
        {
            var node = this._graph.getNode(id);
            if (!node)
            {
                return undefined;
            }

            var schemaElement = this.store.getSchemaElement(node.schemaId);
            return this.getFromCache(schemaElement, node.startId, node.startSchemaId, node.endId, node.endSchemaId, node.id);
        }

        // ------------------------------------------------------------------------------------------------------
        // get a list of elements
        // ------------------------------------------------------------------------------------------------------
        getElements(schemaElement?:SchemaElement, kind:NodeType = NodeType.EdgeOrNode):Queryable<ModelElement>
        {
            if (typeof (schemaElement) === "string")
            {
                schemaElement = this.store.getSchemaElement(schemaElement.toString());
            }
            var _this = this;

            return new Queryable<ModelElement>(
                Utils.select(this._graph.getNodes(kind, schemaElement), function (node)
                    {
                        var schemaElement = _this.store.getSchemaElement(node.schemaId);
                        return _this.getFromCache(schemaElement, node.startId, node.startSchemaId, node.endId, node.endSchemaId, node.id);
                    }
                ));
        }

        private getFromCache(schemaElement:SchemaElement, startId?:string, startSchemaId?:string, endId?:string, endSchemaId?:string, id?:string)
        {
            var mel = this._cache[id];
            if (mel != undefined)
            {
                return mel;
            }
            mel = schemaElement.deserialize(new SerializationContext(this, id, startId, startSchemaId, endId, endSchemaId));
            this._cache[mel.id] = mel;
            return mel;
        }
    }

    // =============================================
    // Domain element
    // =============================================
    export class ModelElement
    {
        id:string;
        schemaElement:SchemaElement;
        domain:DomainModel;
        startId:string;
        startSchemaId:string;
        endId:string;
        endSchemaId:string;
        private _start:ModelElement;
        private _end:ModelElement;
        public disposed:boolean;

        dispose()
        {
            for (var p in this)
            {
                if (p.substr(0, 5) === "__ref")
                {
                    var prop = this[p];
                    if (prop != undefined && prop.dispose)
                    {
                        prop.dispose();
                    }
                }
            }
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        getPropertyValue(property:SchemaProperty):any
        {
            if (this.disposed)
            {
                throw "Can not use a disposed element";
            }
            var pv = this.domain.getPropertyValue(this.id, property);
            if (!pv)
            {
                return undefined;
            }
            return pv.value;
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        setPropertyValue(property:SchemaProperty, value:any)
        {
            if (this.disposed)
            {
                throw "Can not use a disposed element";
            }

            return this.domain.setPropertyValue(this.id, property, value);
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        __initialize(domain:DomainModel, id:string, schemaElement:SchemaElement, startId?:string, startSchemaId?:string, endId?:string, endSchemaId?:string)
        {
            this.domain = domain;
            this.schemaElement = schemaElement;
            this.id = id;
            if (!id)
            {
                this.id = this.domain.createId();
            }
            this.startId = startId;
            this.startSchemaId = startSchemaId;
            this.endId = endId;
            this.endSchemaId = endSchemaId;
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        get start():ModelElement
        {
            if (this.disposed)
            {
                throw "Can not use a disposed element";
            }

            if (!this._start)
            {
                this._start = this.domain.getElement(this.startId);
            }
            return this._start;
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        get end():ModelElement
        {
            if (this.disposed)
            {
                throw "Can not use a disposed element";
            }

            if (!this._end)
            {
                this._end = this.domain.getElement(this.endId);
            }
            return this._end;
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        stringify():string
        {
            if (this.disposed)
            {
                throw "Can not use a disposed element";
            }

            var seen = [];

            var json = JSON.stringify(this, function (k, v)
            {
                if (k.length === 0 || !isNaN(parseInt(k)) || !v)
                {
                    return v;
                }

                switch (k)
                {
                    case "id":
                        if (seen.indexOf(v) !== -1)
                        {
                            return undefined;
                        }
                        seen.push(v);
                        return v;
                    case "startId":
                    case "startSchemaId":
                    case "endId":
                    case "endSchemaId":
                    case "$id":
                        return v;
                    case "schemaElement":
                        return v.id;
                    case "domain":
                    case "start":
                    case "end":
                    case "_start":
                    case "_end":
                        return undefined;
                }

                var p = this.schemaElement.getProperty(k, true);
                if (!p)
                {
                    var r = this.schemaElement.getReference(k, true);

                    if (r  && (!r.opposite && r.schemaRelationship.startProperty || r.opposite && r.schemaRelationship.endProperty ))
                    {
                        if (r.schemaRelationship.cardinality === Cardinality.ManyToMany || !r.opposite && r.schemaRelationship.cardinality === Cardinality.OneToMany
                            || r.opposite && r.schemaRelationship.cardinality === Cardinality.ManyToOne)
                        {
                            return Utils.select(v.items, i => seen.indexOf(i.id) === -1
                                ? i
                                : {$id: i.id});
                        }

                        return seen.indexOf(v.id) === -1
                            ? v
                            : {$id: v.id};
                    }

                    return undefined;
                }

                return p.serialize(v);
            });

            return json;
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        getRelationships(schemaElement?:SchemaRelationship, direction:Direction = Direction.Outgoing):Queryable<ModelElement>
        {
            var list:Queryable<ModelElement>;
            if ((direction & Direction.Outgoing) != 0)
            {
                list = this.domain.getRelationships(schemaElement, this);
            }
            if ((direction & Direction.Incoming) != 0)
            {
                var list2 = this.domain.getRelationships(schemaElement, undefined, this);
                if (list && list.any())
                {
                    list = list.concat(list2);
                }
            }
            return list;
        }
    }

    // ------------------------------------------------------------------------------------------------------
    // encapsulates collection (many references)
    // ------------------------------------------------------------------------------------------------------
    export class ModelElementCollection
    {
        private _source:ModelElement;
        private _end:ModelElement;
        private _schemaRelationship:SchemaRelationship;
        private _domain:DomainModel;
        private addSubscription;
        private _filter:(mel:ModelElement) => boolean;
        private _count:number;

        // ------------------------------------------------------------------------------------------------------
        // add a filter used to filter elements
        // ------------------------------------------------------------------------------------------------------
        public setFilter(where:(mel:ModelElement) => boolean)
        {
            this._filter = where;
            this.clear();
            this.loadItems();
        }

        private clear()
        {
            this._count = 0;
            var self = <any>this;
            while (self.length > 0)
            {
                self.pop();
            }
        }

        // ------------------------------------------------------------------------------------------------------
        //  create a collection where the source element is a terminal of a relationships depending of the opposite value
        //    if opposite is false source is the start element otherwise the end element.
        // ------------------------------------------------------------------------------------------------------
        constructor(source:ModelElement, schemaRelationship:SchemaRelationship, opposite:boolean = false, filter?:(mel:ModelElement) => boolean)
        {
            if (schemaRelationship.cardinality === Cardinality.OneToOne)
            {
                throw "Invalid cardinality. Use reference instead.";
            }

            if (!opposite && !source.schemaElement.isA(schemaRelationship.startSchemaId))
            {
                throw "Invalid source type";
            }
            if (opposite && !source.schemaElement.isA(schemaRelationship.endSchemaId))
            {
                throw "Invalid end type";
            }

            this._source = opposite
                ? undefined
                : source;
            this._end = opposite
                ? source
                : undefined;
            this._schemaRelationship = schemaRelationship;
            this._domain = source.domain;

            this._filter = filter;
            var self = this;
            var cookie = this._domain.events.subscribeSessionCompleted(function (s)
            {
                if (s.aborted)
                {
                    return;
                }

                Utils.forEach(s.events, function (e)
                {
                    if (e.eventName !== "AddRelationshipEvent" && e.eventName !== "RemoveRelationshipEvent")
                    {
                        return;
                    }

                    if (e.schemaId === self._schemaRelationship.id
                        && (self._source && e.startId === self._source.id)
                        || (self._end && e.endId === self._end.id))
                    {
                        if (e.eventName === "AddRelationshipEvent")
                        {
                            var rel = self._domain.store.getElement(e.id);
                            var mel = self._source != undefined
                                ? rel.end
                                : rel.start;

                            if (!self._filter  || self._filter(mel))
                            {
                                Array.prototype.push.call(self, mel);
                                self._count++;
                            }
                        }
                        else
                        {
                            var id = self._source != undefined
                                ? e.endId
                                : e.startId;

                            // Remove
                            for (var k = 0; k < self._count; k++)
                            {
                                if (self[k].id === id)
                                {
                                    if (Array.prototype.splice.call(self, k, 1).length === 1)
                                    {
                                        self._count--;
                                    }
                                    break;
                                }
                            }
                        }
                    }
                });

            });
            this.addSubscription = cookie;

            this._count = 0;
            this.loadItems();
        }

        count():number
        {
            return this._count;
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        private loadItems()
        {
            var opposite = this._source != undefined;
            var rels = this._domain.getRelationships(this._schemaRelationship, this._source, this._end);
            for (var i = 0; i < rels.count; i++)
            {
                var rel = rels[i];
                var elem = opposite
                    ? rel.end
                    : rel.start;
                if (!this._filter || this._filter(elem))
                {
                    Array.prototype.push.call(this, elem);
                    this._count++;
                }
            }
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        dispose()
        {
            this._domain.events.unsubscribeSessionCompleted(this.addSubscription);
            this.clear();
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        remove(mel:ModelElement)
        {
            if ((this._source || this._end).disposed)
            {
                throw "Can not use a disposed element";
            }

            if (mel == null )
            {
                return;
            }

            var source = this._source != undefined
                ? this._source
                : mel;
            var end = this._end != undefined
                ? this._end
                : mel;

            var rel = <ModelElement>(this._domain.getRelationships(this._schemaRelationship, source, end)).firstOrDefault();
            if (rel != undefined)
            {
                this._domain.removeElement(rel.id);
            }
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        add(mel:ModelElement)
        {
            if ((this._source || this._end).disposed)
            {
                throw "Can not use a disposed element";
            }

            if (mel == null)
            {
                return;
            }

            var source = this._source != undefined
                ? this._source
                : mel;
            var end = this._end != undefined
                ? this._end
                : mel;

            var rel = this._source.domain.createRelationship(this._schemaRelationship, source, end.id, end.schemaElement.id);
        }

        forEach(fn) { Utils.forEach(this, fn); }

        firstOrDefault(fn?) { return Utils.firstOrDefault(this, fn); }

        select(fn) { return Utils.select(this, fn); }

        selectMany(fn) { return Utils.selectMany(this, fn); }

        any(fn?):boolean { return Utils.firstOrDefault(this, fn) != undefined; }

        where(fn) { return Utils.where(this, fn); }

        groupBy(fn) { return Utils.groupBy(this, fn); }

        reverse() { return Utils.reverse(this); }
    }

    // -------------------------------------------------------------------------------------
    //
    // -------------------------------------------------------------------------------------
    export class PropertyValue
    {
        constructor(public value:any, public oldValue:any, public version:number)
        { }
    }

    // -------------------------------------------------------------------------------------
    //
    // -------------------------------------------------------------------------------------
    interface handlerInfo
    {
        domain: string;
        handler: IEventHandler;
    }

    // -------------------------------------------------------------------------------------
    //
    // -------------------------------------------------------------------------------------
    export class EventDispatcher implements IEventDispatcher
    {
        private _handlers;

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        constructor(public store:Store)
        {
            this._handlers = {};
            this.registerHandler({
                eventName: "AddEntityEvent", execute: function (d, evt)
                {
                    var schema = d.store.getSchemaEntity(evt.schemaId);
                    d.createEntity(schema, evt.id, evt.version);
                }
            });

            this.registerHandler({
                eventName: "RemoveEntityEvent", execute: function (d, evt)
                {
                    var mel = d.getElement(evt.id);
                    if (!mel)
                    {
                        throw "Invalid element";
                    }
                    d.removeElement(mel.id, evt.version);
                }
            });

            this.registerHandler({
                eventName: "AddRelationshipEvent", execute: function (d, evt)
                {
                    var schema = d.store.getSchemaRelationship(evt.schemaId);
                    var start = d.getElement(evt.startId);
                    if (!start)
                    {
                        throw "Invalid source element for relationship " + evt.id;
                    }
                    d.createRelationship(schema, start, evt.endId, evt.endSchemaId, evt.id, evt.version);
                }
            });

            this.registerHandler({
                eventName: "RemoveRelationshipEvent", execute: function (d, evt)
                {
                    var mel = d.getElement(evt.id);
                    if (!mel)
                    {
                        throw "Invalid element";
                    }
                    d.removeElement(mel.id, evt.version);
                }
            });

            this.registerHandler({
                eventName: "ChangePropertyValueEvent", execute: function (d, evt)
                {
                    var schema = d.store.getSchemaEntity(evt.schemaId);
                    var property = schema.getProperty(evt.propertyName, true);
                    if (property)
                    {
                        d.setPropertyValue(evt.id, property, evt.value, evt.version);
                    }
                }
            });
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        registerHandler(handler:IEventHandler, domain?:string)
        {
            var key = handler.eventName || "*";
            var handlers = this._handlers[key];
            if (!handlers)
            {
                handlers = [];
                this._handlers[key] = handlers;
            }
            handlers.push({domain: domain, handler: handler});
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        handleEvent(event:Event)
        {
            if (!Session.current)
            {
                throw "Session required.";
            }

            var key = event.eventName;
            var flag = this.executeHandlers(key, event);
            if (this.executeHandlers("*", event))
            {
                flag = true;
            }

            if (!flag && event.correlationId !== Session.current.sessionId && !Session.current.closed)
            {
                Session.current.addEvent(event);
            }
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        private executeHandlers(key:string, event:Event):boolean
        {
            var handlers = this._handlers[key];
            if (!handlers)
            {
                return false;
            }
            var domain = this.store.getDomain(event.domain);
            if (!domain)
            {
                return false;
            }

            for (var i = 0; i < handlers.length; i++)
            {
                var handlerInfo = <handlerInfo>handlers[i];
                if (!handlerInfo.domain || event.domain === handlerInfo.domain)
                {
                    handlerInfo.handler.execute(domain, event);
                }
            }
            return handlers.length > 0;
        }
    }

    // -------------------------------------------------------------------------------------
    //
    // -------------------------------------------------------------------------------------
    class Hypergraph
    {
        private nodes;

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        constructor(public domain:DomainModel)
        {
            this.nodes = {};
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        dispose()
        {
            this.nodes = undefined;
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        addNode(id:string, schemaId:string, version:number):GraphNode
        {
            var node = new GraphNode(id, schemaId, NodeType.Node, version);
            if (this.nodes[id] != undefined)
            {
                throw "Duplicate element";
            }
            this.nodes[id] = node;
            return node;
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        addPropertyNode(id:string, schemaId:string, value:any, version:number):GraphNode
        {
            if (this.nodes[id] != undefined)
            {
                throw "Duplicate element";
            }

            var node = new GraphNode(id, schemaId, NodeType.Property, version, undefined, undefined, undefined, undefined, value);
            this.nodes[id] = node;
            return node;
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        addRelationship(id:string, schemaId:string, startId:string, startSchemaId:string, endId:string, endSchemaId:string, version:number):GraphNode
        {

            var node = new GraphNode(id, schemaId, NodeType.Edge, version, startId, startSchemaId, endId, endSchemaId);
            this.nodes[id] = node;

            var start = this.nodes[startId];
            if (!start)
            {
                throw "Invalid element " + startId;
            }

            if (startId === endId)
            {
                start.addEdge(id, schemaId, Direction.Both, startId, startSchemaId);
                return;
            }

            start.addEdge(id, schemaId, Direction.Outgoing, endId, endSchemaId);
            var end = this.nodes[endId];
            if (end)
            {
                end.addEdge(id, schemaId, Direction.Incoming, startId, startSchemaId);
            }
            return node;
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        getNode(id:string):GraphNode
        {
            return this.nodes[id];
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        removeNode(id:string, version:number):Event[]
        {
            var events = [];
            var revents = [];

            var node = this.nodes[id];

            if (!node)
            {
                return events;
            }
            if (!version)
            {
                version = Utils.getUtcNow();
            }

            var sawNodes = {};

            this.traverseNodes(node, node=>
            {
                sawNodes[node.id] = true;

                if (!node.startId)
                {
                    events.push(new RemoveEntityEvent(this.domain.name, node.id, node.schemaId, Session.current.sessionId, version));
                }
                else
                {
                    revents.push(new RemoveRelationshipEvent(this.domain.name, node.id, node.schemaId, node.startId, node.startSchemaId, node.endId, node.endSchemaId, Session.current.sessionId, version));
                }

                var nodes = [];
                for (var k in node.outgoings)
                {
                    var edge = node.outgoings[k];
                    if (!sawNodes[edge.id])
                    {
                        sawNodes[edge.id] = true;
                        nodes.push(this.nodes[edge.id]);
                    }
                }

                for (var k in node.incomings)
                {
                    var edge = node.incomings[k];
                    if (!sawNodes[edge.id])
                    {
                        sawNodes[edge.id] = true;
                        nodes.push(this.nodes[edge.id]);
                    }
                }

                if (node.startId != undefined)
                {
                    var schema = this.domain.store.getSchemaRelationship(node.schemaId);
                    if (schema.embedded)
                    {
                        if (!sawNodes[node.endId])
                        {
                            sawNodes[node.endId] = true;
                            nodes.push(this.nodes[node.endId]);
                        }
                    }
                }

                return nodes;
            });

            var events = revents.concat(events);
            var pevents = [];
            Utils.forEach(events, e=> this.removeNodeInternal(this.nodes[e.id], sawNodes, pevents));
            return pevents.concat(events);
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        private removeNodeInternal(node:GraphNode, sawNodes, events:Event[])
        {
            if (!node)
            {
                return;
            }

            var id = node.id;
            if (node.kind === NodeType.Edge)
            {
                var start = this.nodes[node.startId];
                if (!start)
                {
                    throw "Invalid element " + node.startId;
                }

                start.removeEdge(id, Direction.Outgoing);

                var end = this.nodes[node.endId];
                if (end != undefined)
                {
                    end.removeEdge(id, Direction.Incoming);
                }
            }

            var schema = this.domain.store.getSchemaElement(node.schemaId);
            var self = this;
            schema.getProperties(true).forEach(p=>
            {
                var pid = node.id + p.name;
                var pnode = self.nodes[pid];
                if (pnode != undefined)
                {
                    delete self.nodes[pid];
                    events.push(new RemovePropertyEvent(self.domain.name, node.id, node.schemaId, p.name, pnode.value, Session.current.sessionId, pnode.version));
                }
            });

            delete this.nodes[id];
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        traverseNodes(startNode:GraphNode, visit:(node:GraphNode) => GraphNode[])
        {
            var queue = [];
            queue.push(startNode);

            while (queue.length > 0)
            {
                var node = queue.pop();
                if (!node)
                {
                    continue;
                }

                var nodes = visit(node);
                if (!nodes)
                {
                    return;
                }

                for (var k in nodes)
                {
                    node = nodes[k];
                    queue.unshift(node);
                }
            }
        }

        // -------------------------------------------------------------------------------------
        //
        // -------------------------------------------------------------------------------------
        getNodes(kind:NodeType, schema?:SchemaElement):GraphNode[]
        {
            var list = [];
            for (var key in this.nodes)
            {
                var node = this.nodes[key];
                if ((node.kind & kind) !== 0 && (!schema || schema.id === node.schemaId))
                {
                    list.push(node);
                }
            }
            return list;
        }

    }

    // -------------------------------------------------------------------------------------
    //
    // -------------------------------------------------------------------------------------
    export enum Direction
    {
        Incoming = 1,
        Outgoing = 2,
        Both = 3
    }

    // -------------------------------------------------------------------------------------
    //
    // -------------------------------------------------------------------------------------
    export enum NodeType
    {
        Node = 1,
        Edge = 2,
        EdgeOrNode = 3,
        Property = 4
    }

    // -------------------------------------------------------------------------------------
    //
    // -------------------------------------------------------------------------------------
    class NodeInfo
    {
        constructor(public id:string, public schemaId:string, public version:number)
        {
            if (!version)
            {
                this.version = Utils.getUtcNow();
            }
        }
    }

    // -------------------------------------------------------------------------------------
    //
    // -------------------------------------------------------------------------------------
    class EdgeInfo extends NodeInfo
    {
        constructor(id:string, schemaId:string, version:number, public endId?:string, public endSchemaId?:string)
        {
            super(id, schemaId, version);
        }
    }

    // -------------------------------------------------------------------------------------
    //
    // -------------------------------------------------------------------------------------
    class GraphNode extends EdgeInfo
    {
        public outgoings;
        public incomings;

        public kind:NodeType;
        public startId:string;
        public startSchemaId:string;

        constructor(id:string, schemaId:string, kind:NodeType, version:number, startId?:string, startSchemaId?:string, endId?:string, endSchemaId?:string, public value?:any)
        {
            super(id, schemaId, version, endId, endSchemaId);

            this.kind = kind;
            this.startId = startId;
            this.startSchemaId = startSchemaId;

            this.outgoings = {};
            this.incomings = {};
        }

        addEdge(id:string, edgeSchemaId:string, direction:Direction, endId:string, endSchemaId:string)
        {
            var edge = new EdgeInfo(id, edgeSchemaId, undefined, endId, endSchemaId);

            if ((direction & Direction.Incoming) === Direction.Incoming)
            {
                this.incomings[id] = edge;
            }
            if ((direction & Direction.Outgoing) === Direction.Outgoing)
            {
                this.outgoings[id] = edge;
            }
        }

        removeEdge(id:string, direction:Direction)
        {
            if ((direction & Direction.Incoming) === Direction.Incoming)
            {
                this.incomings.delete(id);
            }
            if ((direction & Direction.Outgoing) === Direction.Outgoing)
            {
                this.outgoings.delete(id);
            }
        }
    }

} 