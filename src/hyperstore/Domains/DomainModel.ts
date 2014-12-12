//	Copyright 2013 - 2014, Alain Metge. All rights reserved. 
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

/// <reference path="../_references.ts" />
module Hyperstore
{
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
        this.name = this.name.toLowerCase();
        this._graph = new Hypergraph(this);
        store.__addDomain(this);
        this.events = new EventManager(this.name);
        this._cache = {};
        this._adapters = [];
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

        return this.name + ":" + (
            id || ++this._sequence).toString();
    }

    addAdapter(adapter:Adapter)
    {
        var self = this;
        adapter.init(this);
        this._adapters.push(adapter);
    }

    /**
     *  Find a schema element by its id in the json compressed data
     * @param schemas - list of schema id from the json
     * @param id - index of the schema
     * @returns {any} - a valid schema id
     */
    private findSchemaId(schemas, id):string
    {
        if (schemas)
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
                        if (schema.name == null) // null or undefined
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

    /**
     * Load a domain from a json object. This object can have two specific format :
     * * hyperstore format. (generated by the hyperstore serializer)
     * * a poco object. For circular references, the newtonwsoft format is used ($id and $ref) (http://james.newtonking.com/json/help/html/T_Newtonsoft_Json_PreserveReferencesHandling.htm)
     *
     * @param def
     * @param rootSchema
     * @returns {ModelElement[]}
     */
    loadFromJson(def:any, rootSchema?:SchemaElement):ModelElement[]
    {
        if (!def)
        {
            return;
        }

        if (def.entities || def.relationships)
        {
            this.store.runInSession(() => this.loadFromHyperstoreJson(def));
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
            this.store.runInSession(
                () =>
                {
                    Utils.forEach(def, e => list.push(this.parseJson(e, rootSchema, refs)));
                }
            );
            return list;
        }
        else
        {
            var r;
            this.store.runInSession(() => r = [this.parseJson(def, rootSchema, refs)]);
            return r;
        }
    }

    private parseJson(obj:any, schema:SchemaElement, refs):ModelElement
    {
        var mel = this.createEntity(schema);
        for (var member in obj)
        {
            if (!obj.hasOwnProperty(member))
                continue;
            var val = obj[member];
            var prop = mel.schemaElement.getProperty(member, true);
            if (prop)
            {
                mel.setPropertyValue(
                    prop, prop.deserialize(
                        new SerializationContext(
                            this, mel.id, undefined, undefined, undefined, undefined, val
                        )
                    )
                );
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

                    if (!src.domain.findRelationships(rel.schemaRelationship, src, end).hasNext())
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
                    this.remove(entityId, entity.v);
                    continue;
                }

                var elem;
                var schemaId = this.findSchemaId(def.schemas, entity["schema"]);
                var schema = this.store.getSchemaElement(schemaId);
                if (!this.elementExists(entityId))
                {
                    list.push(elem = this.createEntity(schema, entityId));
                }

                if (entity.properties)
                {
                    for (var kprop in entity.properties)
                    {
                        var prop = entity.properties[kprop];
                        var propDef = schema.getProperty(<string>prop.name, true);
                        if (propDef)
                        {
                            var v = prop.value;
                            this.setPropertyValue(entityId, propDef, v);
                        }
                    }
                }
            }

            if (def.relationships)
            {
                for (var k = 0; k < def.relationships.length; k++)
                {
                    var relationship = def.relationships[k];
                    var entityId = this.createId(relationship["id"]);
                    if (relationship.state && relationship.state === "D")
                    {
                        this.remove(entityId, relationship.v);
                        continue;
                    }

                    var schemaId = this.findSchemaId(def.schemas, relationship["schema"]);
                    var schema = this.store.getSchemaElement(schemaId);

                    if (!this.elementExists(entityId))
                    {
                        var start = this.get(this.createId(relationship.startId));
                        this.createRelationship(
                            <SchemaRelationship>schema, start, this.createId(relationship.endId),
                            this.findSchemaId(def.schemas, relationship.endSchemaId), entityId
                        );
                    }

                    if (relationship.properties)
                    {
                        for (var kprop in relationship.properties)
                        {
                            var prop = relationship.properties[kprop];
                            var propDef = schema.getProperty(<string>prop.name, true);
                            if (propDef)
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

    /**
     * Get relationships of the domain filtered by schema or terminal elements.
     * Filters can be combined.
     * @param schemaElement: Select only relationships of this schema (including inheritance)
     * @param start: Select outgoing relationships of 'start'
     * @param end : Select incoming relationships of 'end'
     * @returns {ModelElement[]}
     */
    findRelationships(schemaElement?:SchemaRelationship, start?:ModelElement, end?:ModelElement): ICursor
    {
        var list = [];
        var currentSchema = <SchemaElement>schemaElement;
        var tmpSchema = currentSchema;

        if (start)
        {
            var node = this._graph.getNode(start.id);
            if (node)
            {
                for (var relid in node.outgoings)
                {
                    var info = <EdgeInfo>node.outgoings[relid];
                    if (end && end.id !== info.endId)
                    {
                        continue;
                    }

                    tmpSchema = currentSchema;
                    if (schemaElement && schemaElement.id !== tmpSchema.id)
                    {
                        tmpSchema = this.store.getSchemaElement(info.schemaId);
                        if (!tmpSchema.isA(schemaElement.id))
                        {
                            continue;
                        }
                    }
                    var rel = this.getFromCache(
                        tmpSchema, start.id, start.schemaElement.id, info.endId, info.endSchemaId, info.id
                    );
                    list.push(rel);
                }
            }
            return Cursor.from(list);
        }
        else if (end)
        {
            var node = this._graph.getNode(end.id);
            if (node)
            {
                for (var relid in node.incomings)
                {
                    var info = <EdgeInfo>node.incomings[relid];
                    tmpSchema = currentSchema;
                    if (schemaElement && schemaElement.id !== tmpSchema.id)
                    {
                        tmpSchema = this.store.getSchemaElement(info.schemaId);
                        if (!tmpSchema.isA(schemaElement.id))
                        {
                            continue;
                        }
                    }
                    var rel = this.getFromCache(
                        tmpSchema, info.endId, info.endSchemaId, end.id, end.schemaElement.id, info.id
                    );
                    list.push(rel);
                }
            }
            return Cursor.from(list);
        }
        else
        {
            return this._graph.getNodes(NodeType.Edge, schemaElement)
                .map(n=>
                {
                    tmpSchema = currentSchema;
                    if (schemaElement && schemaElement.id !== tmpSchema.id)
                    {
                        tmpSchema = this.store.getSchemaElement(info.schemaId);
                        if (tmpSchema.isA(schemaElement.id))
                        {
                            return this.getFromCache(
                                tmpSchema, n.startId, n.startSchemaId, n.endId, n.endSchemaId, n.id
                            );
                        }
                    }
                    return undefined;
                });
        }
    }

    /**
     * get value of an element property in the underlying hypergraph.
     * Returns 'undefined' if the value doesn't exist and no defaultValue is set in the property schema.
     * Otherwise, returns a PropertyValue {value, version}
     * @param ownerId
     * @param property
     * @returns {*}
     */
    getPropertyValue(ownerId:string, property:SchemaProperty):PropertyValue
    {
        if (!this._graph.getNode(ownerId))
        {
            throw "Invalid element " + ownerId;
        }

        var pid = ownerId + property.name;
        var node = this._graph.getPropertyNode(pid);
        var value = undefined;

        if (!node)
        {
            var def = property.defaultValue;
            if (!def)
            {
                return undefined;
            }
            return new PropertyValue(
                typeof(def) === "function" ? def() : def,
                undefined,
                0
            );
        }

        return new PropertyValue(node.value, undefined, node.version);
    }

    /**
     * set value of an element property
     * @param ownerId
     * @param property
     * @param value
     * @param version
     * @returns {Hyperstore.PropertyValue} {value, oldValue, version}
     */
    setPropertyValue(ownerId:string, property:SchemaProperty, value:any, version?:number):PropertyValue
    {
        var ownerNode = this._graph.getNode(ownerId);
        if (!ownerNode)
        {
            throw "Invalid element " + ownerId;
        }

        var pid = ownerId + property.name;
        var node = this._graph.getPropertyNode(pid);
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

        this.store.runInSession(
            () => Session.current.addEvent(
                new ChangePropertyValueEvent(
                    this.name,
                    ownerId,
                    ownerNode.schemaId,
                    property.name,
                    property.serialize(pv.value),
                    property.serialize(pv.oldValue),
                    Session.current.sessionId,
                    pv.version
                )
            )
        );
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
        if (!isNaN(n) && n > this._sequence)
        {
            this._sequence = n;
        }
    }

    /**
     * create a new domain entity using the specified schema
     * @param schemaElement
     * @param id
     * @param version
     * @returns {Hyperstore.ModelElement}
     */
    createEntity(schemaElement:SchemaElement, id?:string, version?:number):ModelElement
    {
        Utils.Requires(schemaElement, "schemaElement");
        if (typeof(
                schemaElement) == "string")
            schemaElement = this.store.getSchemaEntity(<any>schemaElement);

        var mel = <ModelElement>schemaElement.deserialize(new SerializationContext(this, id));
        this.updateSequence(id);
        var node = this._graph.addNode(mel.id, schemaElement.id, version);
        this.store.runInSession(
            () => Session.current.addEvent(
                new AddEntityEvent(
                    this.name, mel.id, schemaElement.id, Session.current.sessionId, node.version
                )
            )
        );
        this._cache[mel.id] = mel; // TODO cache mel in node and remove _cache
        return mel;
    }

    /**
     * create a new domain relationship using the specified schema
     * @param schemaRelationship
     * @param start
     * @param endId
     * @param endSchemaId
     * @param id
     * @param version
     * @returns {Hyperstore.ModelElement}
     */
    createRelationship(schemaRelationship:SchemaRelationship, start:ModelElement, endId:string, endSchemaId:string, id?:string, version?:number):ModelElement
    {
        Utils.Requires(schemaRelationship, "schemaRelationship");
        Utils.Requires(start, "start");
        Utils.Requires(endId, "endId");
        if (typeof(
                schemaRelationship) == "string")
            schemaRelationship = this.store.getSchemaRelationship(<any>schemaRelationship);

        this.updateSequence(id);
        var mel = <ModelElement>schemaRelationship.deserialize(
            new SerializationContext(
                this, id, start.id, start.schemaElement.id, endId, endSchemaId
            )
        );
        var node = this._graph.addRelationship(
            mel.id, schemaRelationship.id, start.id, start.schemaElement.id, endId, endSchemaId, version
        );
        this.store.runInSession(
            () => Session.current.addEvent(
                new AddRelationshipEvent(
                    this.name, mel.id, schemaRelationship.id, start.id, start.schemaElement.id, endId, endSchemaId,
                    Session.current.sessionId, node.version
                )
            )
        );
        this._cache[mel.id] = mel; // TODO cache mel in node
        return mel;
    }

    /**
     * remove an element (entity or relationship)
     * @param id
     * @param version
     */
    remove(id:string, version?:number)
    {
        var events;
        this.store.runInSession(
            () =>
            {
                events = this._graph.removeNode(id, version);
                Utils.forEach(events, e=> Session.current.events.push(e));
            }
        );

        events.forEach(
                e =>
            {
                var mel = this._cache[e.id];
                if (mel)
                {
                    mel.dispose();
                    delete mel;
                }
            }
        );
    }

    /**
     * check if an element (entity or relationship) exists
     * @param id
     * @returns {boolean}
     */
    elementExists(id:string):boolean
    {
        return !!this._graph.getNode(id);
    }

    /**
     * get an element (entity or relationship) by its id
     * @param id
     * @returns {*}
     */
    get(id:string):ModelElement
    {
        var node = this._graph.getNode(id);
        if (!node)
        {
            return undefined;
        }

        var schemaElement = this.store.getSchemaElement(node.schemaId);
        return this.getFromCache(
            schemaElement, node.startId, node.startSchemaId, node.endId, node.endSchemaId, node.id
        );
    }

    /**
     * get a list of elements
     * @param schemaElement
     * @param kind
     * @returns {ModelElement[]}
     */
    find(schemaElement?:SchemaElement, kind:NodeType = NodeType.EdgeOrNode): ICursor
    {
        if (typeof (
                schemaElement) === "string")
        {
            schemaElement = this.store.getSchemaElement(schemaElement.toString());
        }
        var _this = this;

        return this._graph.getNodes(kind, schemaElement)
            .map( function (node)
            {
                var schemaElement = _this.store.getSchemaElement(node.schemaId);
                return _this.getFromCache(
                    schemaElement, node.startId, node.startSchemaId, node.endId, node.endSchemaId, node.id
                );
            }
        );
    }

    private getFromCache(schemaElement:SchemaElement, startId?:string, startSchemaId?:string, endId?:string, endSchemaId?:string, id?:string)
    {
        var mel = this._cache[id];
        if (mel)
        {
            return mel;
        }
        mel = schemaElement.deserialize(
            new SerializationContext(
                this, id, startId, startSchemaId, endId, endSchemaId
            )
        );
        this._cache[mel.id] = mel;
        return mel;
    }
}

    class Hypergraph
    {
        private _deletedNodes:number = 0;
        _nodes;
        _keys;
        private _properties;
        static DELETED_NODE = '$';

        constructor(public domain:DomainModel)
        {
            this._properties = {};
            this._nodes = [];
            this._keys = {};
        }

        dispose()
        {
            this._keys = null;
            this._nodes = null;
            this._properties = null;
        }

        private addNodeCore(node) : GraphNode {
            var n = this._keys[node.id];
            if (n !== undefined && n !== Hypergraph.DELETED_NODE)
            {
                throw "Duplicate element " + node.id;
            }

            this._keys[node.id] = this._nodes.push( node ) - 1;
            return node;
        }

        addNode(id:string, schemaId:string, version:number):GraphNode
        {
            var node = new GraphNode(id, schemaId, NodeType.Node, version);
            return this.addNodeCore(node);
        }

        addPropertyNode(id:string, schemaId:string, value:any, version:number):GraphNode
        {
            var node = new GraphNode(
                id, schemaId, NodeType.Property, version, undefined, undefined, undefined, undefined, value
            );
            return this._properties[id] = node;
        }

        getPropertyNode(pid:string) : GraphNode {
            return this._properties[pid];
        }

        addRelationship(id:string, schemaId:string, startId:string, startSchemaId:string, endId:string, endSchemaId:string, version:number):GraphNode
        {
            var start = this.getNode(startId);
            if (!start)
            {
                throw "Invalid start element " + startId + " when adding relationship " + id;
            }

            var node = new GraphNode(id, schemaId, NodeType.Edge, version, startId, startSchemaId, endId, endSchemaId);
            this.addNodeCore(node);

            if (startId === endId)
            {
                start.addEdge(id, schemaId, Direction.Both, startId, startSchemaId);
                return node;
            }

            start.addEdge(id, schemaId, Direction.Outgoing, endId, endSchemaId);
            var end = this.getNode(endId);
            if (end)
            {
                end.addEdge(id, schemaId, Direction.Incoming, startId, startSchemaId);
            }
            return node;
        }

        getNode(id:string):GraphNode
        {
            var n = this._keys[id];
            return (n !== undefined && n !== Hypergraph.DELETED_NODE) ? this._nodes[n] : undefined;
        }

        removeNode(id:string, version:number):AbstractEvent[]
        {
            var events = [];
            var revents = [];

            var node = this.getNode(id);
            if (!node)
            {
                return events;
            }
            if (!version)
            {
                version = Utils.getUtcNow();
            }

            var sawNodes = {};

            // Cascading
            this.traverseNodes(
                node, node=>
                {
                    sawNodes[node.id] = true;
                    var evt;
                    if (!node.startId)
                    {
                        evt = new RemoveEntityEvent(
                            this.domain.name, node.id, node.schemaId, Session.current.sessionId, version
                        );
                    }
                    else
                    {
                        evt = new RemoveRelationshipEvent(
                            this.domain.name, node.id, node.schemaId, node.startId, node.startSchemaId, node.endId,
                            node.endSchemaId, Session.current.sessionId, version
                        );
                    }
                    evt.TL = node.id === id; // top level event
                    events.push(evt)

                    // don't replay cascading during rollback or undo/redo
                    if (Session.current.mode & (
                        SessionMode.Rollback | SessionMode.UndoOrRedo))
                        return null;

                    var nodes = [];
                    for (var k in node.outgoings)
                    {
                        var edge = node.outgoings[k];
                        if (!sawNodes[edge.id])
                        {
                            sawNodes[edge.id] = true;
                            nodes.push(this.getNode(edge.id));
                        }
                    }

                    for (var k in node.incomings)
                    {
                        var edge = node.incomings[k];
                        if (!sawNodes[edge.id])
                        {
                            sawNodes[edge.id] = true;
                            nodes.push(this.getNode(edge.id));
                        }
                    }

                    if (node.startId)
                    {
                        var schema = this.domain.store.getSchemaRelationship(node.schemaId);
                        if (schema.embedded)
                        {
                            if (!sawNodes[node.endId])
                            {
                                sawNodes[node.endId] = true;
                                nodes.push(this.getNode(node.endId));
                            }
                        }
                    }

                    return nodes;
                }
            );

            events = revents.concat(events);
            var pevents = [];
            events.forEach(e=> this.removeNodeInternal(e.id, sawNodes, pevents));
            if( this._deletedNodes > 1000)
                this.shrink();
            return pevents.concat(events);
        }

        private shrink() {
            var nodes = [];
            for(var key in this._keys) {
                var n = this._keys[key];
                if( n === Hypergraph.DELETED_NODE)
                    continue;
                this._keys[key] = this._nodes.push(n) - 1;
            }
            this._nodes = nodes;
            this._deletedNodes = 0;
        }

        private removeNodeInternal(id:string, sawNodes, events:AbstractEvent[])
        {
            var index = this._keys[id];
            if (index === undefined || index === Hypergraph.DELETED_NODE)
            {
                return;
            }

            var node = this._nodes[index];
            this._nodes[index] = null;
            this._deletedNodes++;
           // if( this.domain.store.keepDeletedNodes)
                this._keys[id] = Hypergraph.DELETED_NODE;
           // else
           //     delete this._keys[index];

            if (node.kind === NodeType.Edge)
            {
                var start = this.getNode(node.startId);
                if (!start)
                {
                    throw "Invalid element " + node.startId;
                }

                start.removeEdge(id, Direction.Outgoing);

                var end = this.getNode(node.endId);
                if (end)
                {
                    end.removeEdge(id, Direction.Incoming);
                }
            }

            var schema = this.domain.store.getSchemaElement(node.schemaId);
            var self = this;
            schema.getProperties(true).forEach(
                p=>
                {
                    var pid = node.id + p.name;
                    var pnode = self._properties[pid];
                    if (pnode)
                    {
                        delete self._properties[pid];
                        events.push(
                            new RemovePropertyEvent(
                                self.domain.name, node.id, node.schemaId, p.name, pnode.value,
                                Session.current.sessionId, pnode.version
                            )
                        );
                    }
                }
            );
        }

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

        getNodes(kind:NodeType, schema?:SchemaElement): NodesCursor
        {
            return new NodesCursor(this, kind, schema);
        }

    }

    export interface ICursor {
        hasNext():boolean;
        next:any;
        reset();
    }

    export class Cursor implements ICursor {
        reset() {}
        hasNext():boolean {throw "not implemented. Use Cursor.from to instanciate a cursor.";}
        next() {return undefined;}

        firstOrDefault() {
            var r = this.hasNext() ? this.next() : undefined;
            this.reset();
            return r;
        }

        forEach(callback) {
            while(this.hasNext()) {
                callback(this.next());
            }
            this.reset();
        }

        any() : boolean {
            var r = this.hasNext();
            this.reset();
            return r;
        }

        toArray() : any[] {
            var list = [];
            this.forEach(n=>list.push(n));
            return list;
        }

        map(callback) : ICursor {
            return new MapCursor(callback, this);
        }

        static from(obj) : ICursor {
            if( Array.isArray(obj))
                return new ArrayCursor(obj);

            if(obj.hasNext)
                return obj;

            if( obj instanceof ModelElementCollection)
                return new ArrayCursor(obj);

            throw "Not implemented";
        }
    }

    class MapCursor extends Cursor {
        private _current;

        constructor(private _filter, private _cursor:ICursor) {
            super();
            this.reset();
        }

        reset() {
            this._cursor.reset();
            this._current = undefined;
        }

        hasNext() : boolean {
            while(true) {
                if( !this._cursor.hasNext())
                    return false;
                var r = this._filter(this._cursor.next());
                if( r ) {
                    this._current = r;
                    return true;
                }
            }
        }

        next() {
            return this._current;
        }
    }

    class ArrayCursor extends Cursor implements ICursor {
        private _index:number;

        constructor(private _array) {
            super();
            this.reset();
        }

        reset() {
            this._index = 0;
        }

        hasNext() : boolean {
            if( this._index === this._array.length)
                return false;
            this._index++;
            return true;
        }

        next() : any {
            return this._array[this._index-1];
        }
    }

    class NodesCursor extends Cursor implements ICursor {
        private _index : number;
        private _current : GraphNode;

        constructor(private _graph:Hypergraph, private _kind:NodeType, private _schema:SchemaElement) {
            super();
            this.reset();
        }

        reset() {
            this._index = 0;
            this._current = undefined;
        }

        hasNext() : boolean {
            while(true) {
                if( this._index === this._graph._nodes.length) {
                    this._current = undefined;
                    return false;
                }
                this._index++;
                var node = this._graph._nodes[this._index-1];
                if( node && node !== Hypergraph.DELETED_NODE && (node.kind & this._kind) !== 0
                    && (!this._schema || this._schema.id === node.schemaId))
                {
                    this._current = node;
                    return true;
                }
            }
        }

        next() : any {
            return this._current;
        }
    }
    /**
     *
     */
    export enum Direction
    {
        Incoming = 1,
        Outgoing = 2,
        Both = 3
    }

    /**
     *
     */
    export enum NodeType
    {
        Node = 1,
        Edge = 2,
        EdgeOrNode = 3,
        Property = 4
    }

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

    class EdgeInfo extends NodeInfo
    {
        constructor(id:string, schemaId:string, version:number, public endId?:string, public endSchemaId?:string)
        {
            super(id, schemaId, version);
        }
    }

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

            if ((
                direction & Direction.Incoming) === Direction.Incoming)
            {
                this.incomings[id] = edge;
            }
            if ((
                direction & Direction.Outgoing) === Direction.Outgoing)
            {
                this.outgoings[id] = edge;
            }
        }

        removeEdge(id:string, direction:Direction)
        {
            if ((
                direction & Direction.Incoming) === Direction.Incoming)
            {
                delete this.incomings[id];
            }
            if ((
                direction & Direction.Outgoing) === Direction.Outgoing)
            {
                delete this.outgoings[id];
            }
        }
    }
}