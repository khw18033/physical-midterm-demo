/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-mixed-operators, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars, default-case, jsdoc/require-param*/
import $protobuf from "protobufjs/minimal.js";

// Common aliases
const $Reader = $protobuf.Reader, $Writer = $protobuf.Writer, $util = $protobuf.util;
const $Object = $util.global.Object, $undefined = $util.global.undefined, $Error = $util.global.Error, $RangeError = $util.global.RangeError, $TypeError = $util.global.TypeError, $String = $util.global.String, $Number = $util.global.Number, $parseInt = $util.global.parseInt, $BigInt = $util.global.BigInt, $isFinite = $util.global.isFinite, $Boolean = $util.global.Boolean, $Array = $util.global.Array;

// Exported root namespace
const $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});

export const physical = $root.physical = (() => {

    /**
     * Namespace physical.
     * @exports physical
     * @namespace
     */
    const physical = {};

    physical.PhysicalCommandEnvelope = (function() {

        /**
         * Properties of a PhysicalCommandEnvelope.
         * @typedef {Object} physical.PhysicalCommandEnvelope.$Properties
         * @property {physical.Command.$Properties|null} [command] PhysicalCommandEnvelope command
         * @property {physical.CancelCommandRequest.$Properties|null} [cancelRequest] PhysicalCommandEnvelope cancelRequest
         * @property {physical.CommandAcceptance.$Properties|null} [acceptance] PhysicalCommandEnvelope acceptance
         * @property {physical.CommandStatus.$Properties|null} [status] PhysicalCommandEnvelope status
         * @property {physical.CommandResult.$Properties|null} [result] PhysicalCommandEnvelope result
         * @property {physical.CancelCommandResponse.$Properties|null} [cancelResponse] PhysicalCommandEnvelope cancelResponse
         * @property {physical.Capability.$Properties|null} [capability] PhysicalCommandEnvelope capability
         * @property {"command"|"cancelRequest"|"acceptance"|"status"|"result"|"cancelResponse"|"capability"} [body] PhysicalCommandEnvelope body
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */

        /**
         * Properties of a PhysicalCommandEnvelope.
         * @memberof physical
         * @interface IPhysicalCommandEnvelope
         * @augments physical.PhysicalCommandEnvelope.$Properties
         * @deprecated Use physical.PhysicalCommandEnvelope.$Properties instead.
         */

        /**
         * Narrowed shape of a PhysicalCommandEnvelope.
         * @typedef {{
         *   command?: physical.Command.$Shape|null;
         *   cancelRequest?: physical.CancelCommandRequest.$Shape|null;
         *   acceptance?: physical.CommandAcceptance.$Shape|null;
         *   status?: physical.CommandStatus.$Shape|null;
         *   result?: physical.CommandResult.$Shape|null;
         *   cancelResponse?: physical.CancelCommandResponse.$Shape|null;
         *   capability?: physical.Capability.$Shape|null;
         *   $unknowns?: Array.<Uint8Array>;
         * } & (
         *   ({ body?: undefined; command?: null; cancelRequest?: null; acceptance?: null; status?: null; result?: null; cancelResponse?: null; capability?: null }|{ body?: "command"; command: physical.Command.$Shape; cancelRequest?: null; acceptance?: null; status?: null; result?: null; cancelResponse?: null; capability?: null }|{ body?: "cancelRequest"; command?: null; cancelRequest: physical.CancelCommandRequest.$Shape; acceptance?: null; status?: null; result?: null; cancelResponse?: null; capability?: null }|{ body?: "acceptance"; command?: null; cancelRequest?: null; acceptance: physical.CommandAcceptance.$Shape; status?: null; result?: null; cancelResponse?: null; capability?: null }|{ body?: "status"; command?: null; cancelRequest?: null; acceptance?: null; status: physical.CommandStatus.$Shape; result?: null; cancelResponse?: null; capability?: null }|{ body?: "result"; command?: null; cancelRequest?: null; acceptance?: null; status?: null; result: physical.CommandResult.$Shape; cancelResponse?: null; capability?: null }|{ body?: "cancelResponse"; command?: null; cancelRequest?: null; acceptance?: null; status?: null; result?: null; cancelResponse: physical.CancelCommandResponse.$Shape; capability?: null }|{ body?: "capability"; command?: null; cancelRequest?: null; acceptance?: null; status?: null; result?: null; cancelResponse?: null; capability: physical.Capability.$Shape })
         * )} physical.PhysicalCommandEnvelope.$Shape
         */

        /**
         * Constructs a new PhysicalCommandEnvelope.
         * @memberof physical
         * @classdesc Represents a PhysicalCommandEnvelope.
         * @constructor
         * @param {physical.PhysicalCommandEnvelope.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */
        const PhysicalCommandEnvelope = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * PhysicalCommandEnvelope command.
         * @member {physical.Command.$Properties|null|undefined} command
         * @memberof physical.PhysicalCommandEnvelope
         * @instance
         */
        PhysicalCommandEnvelope.prototype.command = null;

        /**
         * PhysicalCommandEnvelope cancelRequest.
         * @member {physical.CancelCommandRequest.$Properties|null|undefined} cancelRequest
         * @memberof physical.PhysicalCommandEnvelope
         * @instance
         */
        PhysicalCommandEnvelope.prototype.cancelRequest = null;

        /**
         * PhysicalCommandEnvelope acceptance.
         * @member {physical.CommandAcceptance.$Properties|null|undefined} acceptance
         * @memberof physical.PhysicalCommandEnvelope
         * @instance
         */
        PhysicalCommandEnvelope.prototype.acceptance = null;

        /**
         * PhysicalCommandEnvelope status.
         * @member {physical.CommandStatus.$Properties|null|undefined} status
         * @memberof physical.PhysicalCommandEnvelope
         * @instance
         */
        PhysicalCommandEnvelope.prototype.status = null;

        /**
         * PhysicalCommandEnvelope result.
         * @member {physical.CommandResult.$Properties|null|undefined} result
         * @memberof physical.PhysicalCommandEnvelope
         * @instance
         */
        PhysicalCommandEnvelope.prototype.result = null;

        /**
         * PhysicalCommandEnvelope cancelResponse.
         * @member {physical.CancelCommandResponse.$Properties|null|undefined} cancelResponse
         * @memberof physical.PhysicalCommandEnvelope
         * @instance
         */
        PhysicalCommandEnvelope.prototype.cancelResponse = null;

        /**
         * PhysicalCommandEnvelope capability.
         * @member {physical.Capability.$Properties|null|undefined} capability
         * @memberof physical.PhysicalCommandEnvelope
         * @instance
         */
        PhysicalCommandEnvelope.prototype.capability = null;

        // OneOf field names bound to virtual getters and setters
        let $oneOfFields;

        /**
         * PhysicalCommandEnvelope body.
         * @member {"command"|"cancelRequest"|"acceptance"|"status"|"result"|"cancelResponse"|"capability"|undefined} body
         * @memberof physical.PhysicalCommandEnvelope
         * @instance
         */
        $Object.defineProperty(PhysicalCommandEnvelope.prototype, "body", {
            get: $util.oneOfGetter($oneOfFields = ["command", "cancelRequest", "acceptance", "status", "result", "cancelResponse", "capability"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new PhysicalCommandEnvelope instance using the specified properties.
         * @function create
         * @memberof physical.PhysicalCommandEnvelope
         * @static
         * @param {physical.PhysicalCommandEnvelope.$Properties=} [properties] Properties to set
         * @returns {physical.PhysicalCommandEnvelope} PhysicalCommandEnvelope instance
         * @type {{
         *   (properties: physical.PhysicalCommandEnvelope.$Shape): physical.PhysicalCommandEnvelope & physical.PhysicalCommandEnvelope.$Shape;
         *   (properties?: physical.PhysicalCommandEnvelope.$Properties): physical.PhysicalCommandEnvelope;
         * }}
         */
        PhysicalCommandEnvelope.create = function(properties) {
            return new PhysicalCommandEnvelope(properties);
        };

        /**
         * Encodes the specified PhysicalCommandEnvelope message. Does not implicitly {@link physical.PhysicalCommandEnvelope.verify|verify} messages.
         * @function encode
         * @memberof physical.PhysicalCommandEnvelope
         * @static
         * @param {physical.PhysicalCommandEnvelope.$Properties} message PhysicalCommandEnvelope message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PhysicalCommandEnvelope.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.command != null && $Object.hasOwnProperty.call(message, "command"))
                $root.physical.Command.encode(message.command, writer.uint32(/* id 1, wireType 2 =*/10).fork(), _depth + 1).ldelim();
            if (message.cancelRequest != null && $Object.hasOwnProperty.call(message, "cancelRequest"))
                $root.physical.CancelCommandRequest.encode(message.cancelRequest, writer.uint32(/* id 2, wireType 2 =*/18).fork(), _depth + 1).ldelim();
            if (message.acceptance != null && $Object.hasOwnProperty.call(message, "acceptance"))
                $root.physical.CommandAcceptance.encode(message.acceptance, writer.uint32(/* id 3, wireType 2 =*/26).fork(), _depth + 1).ldelim();
            if (message.status != null && $Object.hasOwnProperty.call(message, "status"))
                $root.physical.CommandStatus.encode(message.status, writer.uint32(/* id 4, wireType 2 =*/34).fork(), _depth + 1).ldelim();
            if (message.result != null && $Object.hasOwnProperty.call(message, "result"))
                $root.physical.CommandResult.encode(message.result, writer.uint32(/* id 5, wireType 2 =*/42).fork(), _depth + 1).ldelim();
            if (message.cancelResponse != null && $Object.hasOwnProperty.call(message, "cancelResponse"))
                $root.physical.CancelCommandResponse.encode(message.cancelResponse, writer.uint32(/* id 6, wireType 2 =*/50).fork(), _depth + 1).ldelim();
            if (message.capability != null && $Object.hasOwnProperty.call(message, "capability"))
                $root.physical.Capability.encode(message.capability, writer.uint32(/* id 7, wireType 2 =*/58).fork(), _depth + 1).ldelim();
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified PhysicalCommandEnvelope message, length delimited. Does not implicitly {@link physical.PhysicalCommandEnvelope.verify|verify} messages.
         * @function encodeDelimited
         * @memberof physical.PhysicalCommandEnvelope
         * @static
         * @param {physical.PhysicalCommandEnvelope.$Properties} message PhysicalCommandEnvelope message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PhysicalCommandEnvelope.encodeDelimited = function(message, writer) {
            return this.encode(message, (writer || $Writer.create()).fork()).ldelim();
        };

        /**
         * Decodes a PhysicalCommandEnvelope message from the specified reader or buffer.
         * @function decode
         * @memberof physical.PhysicalCommandEnvelope
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {physical.PhysicalCommandEnvelope & physical.PhysicalCommandEnvelope.$Shape} PhysicalCommandEnvelope
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PhysicalCommandEnvelope.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.physical.PhysicalCommandEnvelope();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        message.command = $root.physical.Command.decode(reader, reader.uint32(), $undefined, _depth + 1, message.command);
                        message.body = "command";
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        message.cancelRequest = $root.physical.CancelCommandRequest.decode(reader, reader.uint32(), $undefined, _depth + 1, message.cancelRequest);
                        message.body = "cancelRequest";
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        message.acceptance = $root.physical.CommandAcceptance.decode(reader, reader.uint32(), $undefined, _depth + 1, message.acceptance);
                        message.body = "acceptance";
                        continue;
                    }
                case 4: {
                        if (wireType !== 2)
                            break;
                        message.status = $root.physical.CommandStatus.decode(reader, reader.uint32(), $undefined, _depth + 1, message.status);
                        message.body = "status";
                        continue;
                    }
                case 5: {
                        if (wireType !== 2)
                            break;
                        message.result = $root.physical.CommandResult.decode(reader, reader.uint32(), $undefined, _depth + 1, message.result);
                        message.body = "result";
                        continue;
                    }
                case 6: {
                        if (wireType !== 2)
                            break;
                        message.cancelResponse = $root.physical.CancelCommandResponse.decode(reader, reader.uint32(), $undefined, _depth + 1, message.cancelResponse);
                        message.body = "cancelResponse";
                        continue;
                    }
                case 7: {
                        if (wireType !== 2)
                            break;
                        message.capability = $root.physical.Capability.decode(reader, reader.uint32(), $undefined, _depth + 1, message.capability);
                        message.body = "capability";
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a PhysicalCommandEnvelope message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof physical.PhysicalCommandEnvelope
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {physical.PhysicalCommandEnvelope & physical.PhysicalCommandEnvelope.$Shape} PhysicalCommandEnvelope
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PhysicalCommandEnvelope.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a PhysicalCommandEnvelope message.
         * @function verify
         * @memberof physical.PhysicalCommandEnvelope
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        PhysicalCommandEnvelope.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            let properties = {};
            if (message.command != null && $Object.hasOwnProperty.call(message, "command")) {
                properties.body = 1;
                {
                    let error = $root.physical.Command.verify(message.command, _depth + 1);
                    if (error)
                        return "command." + error;
                }
            }
            if (message.cancelRequest != null && $Object.hasOwnProperty.call(message, "cancelRequest")) {
                if (properties.body === 1)
                    return "body: multiple values";
                properties.body = 1;
                {
                    let error = $root.physical.CancelCommandRequest.verify(message.cancelRequest, _depth + 1);
                    if (error)
                        return "cancelRequest." + error;
                }
            }
            if (message.acceptance != null && $Object.hasOwnProperty.call(message, "acceptance")) {
                if (properties.body === 1)
                    return "body: multiple values";
                properties.body = 1;
                {
                    let error = $root.physical.CommandAcceptance.verify(message.acceptance, _depth + 1);
                    if (error)
                        return "acceptance." + error;
                }
            }
            if (message.status != null && $Object.hasOwnProperty.call(message, "status")) {
                if (properties.body === 1)
                    return "body: multiple values";
                properties.body = 1;
                {
                    let error = $root.physical.CommandStatus.verify(message.status, _depth + 1);
                    if (error)
                        return "status." + error;
                }
            }
            if (message.result != null && $Object.hasOwnProperty.call(message, "result")) {
                if (properties.body === 1)
                    return "body: multiple values";
                properties.body = 1;
                {
                    let error = $root.physical.CommandResult.verify(message.result, _depth + 1);
                    if (error)
                        return "result." + error;
                }
            }
            if (message.cancelResponse != null && $Object.hasOwnProperty.call(message, "cancelResponse")) {
                if (properties.body === 1)
                    return "body: multiple values";
                properties.body = 1;
                {
                    let error = $root.physical.CancelCommandResponse.verify(message.cancelResponse, _depth + 1);
                    if (error)
                        return "cancelResponse." + error;
                }
            }
            if (message.capability != null && $Object.hasOwnProperty.call(message, "capability")) {
                if (properties.body === 1)
                    return "body: multiple values";
                properties.body = 1;
                {
                    let error = $root.physical.Capability.verify(message.capability, _depth + 1);
                    if (error)
                        return "capability." + error;
                }
            }
            return null;
        };

        /**
         * Creates a PhysicalCommandEnvelope message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof physical.PhysicalCommandEnvelope
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {physical.PhysicalCommandEnvelope} PhysicalCommandEnvelope
         */
        PhysicalCommandEnvelope.fromObject = function (object, _depth) {
            if (object instanceof $root.physical.PhysicalCommandEnvelope)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".physical.PhysicalCommandEnvelope: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.physical.PhysicalCommandEnvelope();
            if (object.command != null) {
                if (!$util.isObject(object.command))
                    throw $TypeError(".physical.PhysicalCommandEnvelope.command: object expected");
                message.command = $root.physical.Command.fromObject(object.command, _depth + 1);
            }
            if (object.cancelRequest != null) {
                if (!$util.isObject(object.cancelRequest))
                    throw $TypeError(".physical.PhysicalCommandEnvelope.cancelRequest: object expected");
                message.cancelRequest = $root.physical.CancelCommandRequest.fromObject(object.cancelRequest, _depth + 1);
            }
            if (object.acceptance != null) {
                if (!$util.isObject(object.acceptance))
                    throw $TypeError(".physical.PhysicalCommandEnvelope.acceptance: object expected");
                message.acceptance = $root.physical.CommandAcceptance.fromObject(object.acceptance, _depth + 1);
            }
            if (object.status != null) {
                if (!$util.isObject(object.status))
                    throw $TypeError(".physical.PhysicalCommandEnvelope.status: object expected");
                message.status = $root.physical.CommandStatus.fromObject(object.status, _depth + 1);
            }
            if (object.result != null) {
                if (!$util.isObject(object.result))
                    throw $TypeError(".physical.PhysicalCommandEnvelope.result: object expected");
                message.result = $root.physical.CommandResult.fromObject(object.result, _depth + 1);
            }
            if (object.cancelResponse != null) {
                if (!$util.isObject(object.cancelResponse))
                    throw $TypeError(".physical.PhysicalCommandEnvelope.cancelResponse: object expected");
                message.cancelResponse = $root.physical.CancelCommandResponse.fromObject(object.cancelResponse, _depth + 1);
            }
            if (object.capability != null) {
                if (!$util.isObject(object.capability))
                    throw $TypeError(".physical.PhysicalCommandEnvelope.capability: object expected");
                message.capability = $root.physical.Capability.fromObject(object.capability, _depth + 1);
            }
            return message;
        };

        /**
         * Creates a plain object from a PhysicalCommandEnvelope message. Also converts values to other types if specified.
         * @function toObject
         * @memberof physical.PhysicalCommandEnvelope
         * @static
         * @param {physical.PhysicalCommandEnvelope} message PhysicalCommandEnvelope
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        PhysicalCommandEnvelope.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (message.command != null && $Object.hasOwnProperty.call(message, "command")) {
                object.command = $root.physical.Command.toObject(message.command, options, _depth + 1);
                if (options.oneofs)
                    object.body = "command";
            }
            if (message.cancelRequest != null && $Object.hasOwnProperty.call(message, "cancelRequest")) {
                object.cancelRequest = $root.physical.CancelCommandRequest.toObject(message.cancelRequest, options, _depth + 1);
                if (options.oneofs)
                    object.body = "cancelRequest";
            }
            if (message.acceptance != null && $Object.hasOwnProperty.call(message, "acceptance")) {
                object.acceptance = $root.physical.CommandAcceptance.toObject(message.acceptance, options, _depth + 1);
                if (options.oneofs)
                    object.body = "acceptance";
            }
            if (message.status != null && $Object.hasOwnProperty.call(message, "status")) {
                object.status = $root.physical.CommandStatus.toObject(message.status, options, _depth + 1);
                if (options.oneofs)
                    object.body = "status";
            }
            if (message.result != null && $Object.hasOwnProperty.call(message, "result")) {
                object.result = $root.physical.CommandResult.toObject(message.result, options, _depth + 1);
                if (options.oneofs)
                    object.body = "result";
            }
            if (message.cancelResponse != null && $Object.hasOwnProperty.call(message, "cancelResponse")) {
                object.cancelResponse = $root.physical.CancelCommandResponse.toObject(message.cancelResponse, options, _depth + 1);
                if (options.oneofs)
                    object.body = "cancelResponse";
            }
            if (message.capability != null && $Object.hasOwnProperty.call(message, "capability")) {
                object.capability = $root.physical.Capability.toObject(message.capability, options, _depth + 1);
                if (options.oneofs)
                    object.body = "capability";
            }
            return object;
        };

        /**
         * Converts this PhysicalCommandEnvelope to JSON.
         * @function toJSON
         * @memberof physical.PhysicalCommandEnvelope
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        PhysicalCommandEnvelope.prototype.toJSON = function() {
            return PhysicalCommandEnvelope.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for PhysicalCommandEnvelope
         * @function getTypeUrl
         * @memberof physical.PhysicalCommandEnvelope
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        PhysicalCommandEnvelope.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/physical.PhysicalCommandEnvelope";
        };

        return PhysicalCommandEnvelope;
    })();

    /**
     * TerminalStatus enum.
     * @name physical.TerminalStatus
     * @enum {number}
     * @property {number} TERMINAL_STATUS_UNSPECIFIED=0 TERMINAL_STATUS_UNSPECIFIED value
     * @property {number} SUCCEEDED=1 SUCCEEDED value
     * @property {number} ABORTED=2 ABORTED value
     * @property {number} CANCELED=3 CANCELED value
     */
    physical.TerminalStatus = (function() {
        const valuesById = $Object.create(null), values = $Object.create(valuesById);
        values[valuesById[0] = "TERMINAL_STATUS_UNSPECIFIED"] = 0;
        values[valuesById[1] = "SUCCEEDED"] = 1;
        values[valuesById[2] = "ABORTED"] = 2;
        values[valuesById[3] = "CANCELED"] = 3;
        return values;
    })();

    physical.Command = (function() {

        /**
         * Properties of a Command.
         * @typedef {Object} physical.Command.$Properties
         * @property {string|null} [commandId] Command commandId
         * @property {string|null} [target] Command target
         * @property {string|null} [action] Command action
         * @property {Object.<string,number>|null} [parameters] Command parameters
         * @property {number|Long|null} [deadlineUnixMs] Command deadlineUnixMs
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */

        /**
         * Properties of a Command.
         * @memberof physical
         * @interface ICommand
         * @augments physical.Command.$Properties
         * @deprecated Use physical.Command.$Properties instead.
         */

        /**
         * Shape of a Command.
         * @typedef {physical.Command.$Properties} physical.Command.$Shape
         */

        /**
         * Constructs a new Command.
         * @memberof physical
         * @classdesc Represents a Command.
         * @constructor
         * @param {physical.Command.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */
        const Command = function (properties) {
            this.parameters = {};
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * Command commandId.
         * @member {string} commandId
         * @memberof physical.Command
         * @instance
         */
        Command.prototype.commandId = "";

        /**
         * Command target.
         * @member {string} target
         * @memberof physical.Command
         * @instance
         */
        Command.prototype.target = "";

        /**
         * Command action.
         * @member {string} action
         * @memberof physical.Command
         * @instance
         */
        Command.prototype.action = "";

        /**
         * Command parameters.
         * @member {Object.<string,number>} parameters
         * @memberof physical.Command
         * @instance
         */
        Command.prototype.parameters = $util.emptyObject;

        /**
         * Command deadlineUnixMs.
         * @member {number|Long} deadlineUnixMs
         * @memberof physical.Command
         * @instance
         */
        Command.prototype.deadlineUnixMs = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

        /**
         * Creates a new Command instance using the specified properties.
         * @function create
         * @memberof physical.Command
         * @static
         * @param {physical.Command.$Properties=} [properties] Properties to set
         * @returns {physical.Command} Command instance
         * @type {{
         *   (properties: physical.Command.$Shape): physical.Command & physical.Command.$Shape;
         *   (properties?: physical.Command.$Properties): physical.Command;
         * }}
         */
        Command.create = function(properties) {
            return new Command(properties);
        };

        /**
         * Encodes the specified Command message. Does not implicitly {@link physical.Command.verify|verify} messages.
         * @function encode
         * @memberof physical.Command
         * @static
         * @param {physical.Command.$Properties} message Command message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Command.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId") && message.commandId !== "")
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.commandId);
            if (message.target != null && $Object.hasOwnProperty.call(message, "target") && message.target !== "")
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.target);
            if (message.action != null && $Object.hasOwnProperty.call(message, "action") && message.action !== "")
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.action);
            if (message.parameters != null && $Object.hasOwnProperty.call(message, "parameters"))
                for (let keys = $Object.keys(message.parameters), i = 0; i < keys.length; ++i)
                    writer.uint32(/* id 4, wireType 2 =*/34).fork().uint32(/* id 1, wireType 2 =*/10).string(keys[i]).uint32(/* id 2, wireType 1 =*/17).double(message.parameters[keys[i]]).ldelim();
            if (message.deadlineUnixMs != null && $Object.hasOwnProperty.call(message, "deadlineUnixMs") && (typeof message.deadlineUnixMs === "object" ? message.deadlineUnixMs.low || message.deadlineUnixMs.high : message.deadlineUnixMs !== 0))
                writer.uint32(/* id 5, wireType 0 =*/40).int64(message.deadlineUnixMs);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified Command message, length delimited. Does not implicitly {@link physical.Command.verify|verify} messages.
         * @function encodeDelimited
         * @memberof physical.Command
         * @static
         * @param {physical.Command.$Properties} message Command message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Command.encodeDelimited = function(message, writer) {
            return this.encode(message, (writer || $Writer.create()).fork()).ldelim();
        };

        /**
         * Decodes a Command message from the specified reader or buffer.
         * @function decode
         * @memberof physical.Command
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {physical.Command & physical.Command.$Shape} Command
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Command.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message, key, value;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.physical.Command();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.commandId = value;
                        else
                            delete message.commandId;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.target = value;
                        else
                            delete message.target;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.action = value;
                        else
                            delete message.action;
                        continue;
                    }
                case 4: {
                        if (wireType !== 2)
                            break;
                        if (message.parameters === $util.emptyObject)
                            message.parameters = {};
                        let end2 = reader.uint32() + reader.pos;
                        if (end2 > reader.len)
                            throw $RangeError("index out of range");
                        reader.len = end2;
                        key = "";
                        value = 0;
                        while (reader.pos < end2) {
                            let tag2 = reader.tag();
                            wireType = tag2 & 7;
                            switch (tag2 >>>= 3) {
                            case 1:
                                if (wireType !== 2)
                                    break;
                                key = reader.stringVerify();
                                continue;
                            case 2:
                                if (wireType !== 1)
                                    break;
                                value = reader.double();
                                continue;
                            }
                            reader.skipType(wireType, _depth, tag2);
                        }
                        if (reader.pos !== end2)
                            throw $RangeError("index out of range");
                        reader.len = end;
                        if (key === "__proto__")
                            $util.makeProp(message.parameters, key);
                        message.parameters[key] = value;
                        continue;
                    }
                case 5: {
                        if (wireType !== 0)
                            break;
                        if (typeof (value = reader.int64()) === "object" ? value.low || value.high : value !== 0)
                            message.deadlineUnixMs = value;
                        else
                            delete message.deadlineUnixMs;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a Command message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof physical.Command
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {physical.Command & physical.Command.$Shape} Command
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Command.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Command message.
         * @function verify
         * @memberof physical.Command
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Command.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId"))
                if (!$util.isString(message.commandId))
                    return "commandId: string expected";
            if (message.target != null && $Object.hasOwnProperty.call(message, "target"))
                if (!$util.isString(message.target))
                    return "target: string expected";
            if (message.action != null && $Object.hasOwnProperty.call(message, "action"))
                if (!$util.isString(message.action))
                    return "action: string expected";
            if (message.parameters != null && $Object.hasOwnProperty.call(message, "parameters")) {
                if (!$util.isObject(message.parameters))
                    return "parameters: object expected";
                let key = $Object.keys(message.parameters);
                for (let i = 0; i < key.length; ++i)
                    if (typeof message.parameters[key[i]] !== "number")
                        return "parameters: number{k:string} expected";
            }
            if (message.deadlineUnixMs != null && $Object.hasOwnProperty.call(message, "deadlineUnixMs"))
                if (!$util.isInteger(message.deadlineUnixMs) && !(message.deadlineUnixMs && $util.isInteger(message.deadlineUnixMs.low) && $util.isInteger(message.deadlineUnixMs.high)))
                    return "deadlineUnixMs: integer|Long expected";
            return null;
        };

        /**
         * Creates a Command message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof physical.Command
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {physical.Command} Command
         */
        Command.fromObject = function (object, _depth) {
            if (object instanceof $root.physical.Command)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".physical.Command: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.physical.Command();
            if (object.commandId != null)
                if (typeof object.commandId !== "string" || object.commandId.length)
                    message.commandId = $String(object.commandId);
            if (object.target != null)
                if (typeof object.target !== "string" || object.target.length)
                    message.target = $String(object.target);
            if (object.action != null)
                if (typeof object.action !== "string" || object.action.length)
                    message.action = $String(object.action);
            if (object.parameters) {
                if (!$util.isObject(object.parameters))
                    throw $TypeError(".physical.Command.parameters: object expected");
                message.parameters = {};
                for (let keys = $Object.keys(object.parameters), i = 0; i < keys.length; ++i) {
                    if (keys[i] === "__proto__")
                        $util.makeProp(message.parameters, keys[i]);
                    message.parameters[keys[i]] = $Number(object.parameters[keys[i]]);
                }
            }
            if (object.deadlineUnixMs != null)
                if (typeof object.deadlineUnixMs === "object" ? object.deadlineUnixMs.low || object.deadlineUnixMs.high : $Number(object.deadlineUnixMs) !== 0)
                    if ($util.Long)
                        message.deadlineUnixMs = $util.Long.fromValue(object.deadlineUnixMs, false);
                    else if (typeof object.deadlineUnixMs === "string")
                        message.deadlineUnixMs = $parseInt(object.deadlineUnixMs, 10);
                    else if (typeof object.deadlineUnixMs === "number")
                        message.deadlineUnixMs = object.deadlineUnixMs;
                    else if (typeof object.deadlineUnixMs === "object")
                        message.deadlineUnixMs = new $util.LongBits(object.deadlineUnixMs.low >>> 0, object.deadlineUnixMs.high >>> 0).toNumber();
            return message;
        };

        /**
         * Creates a plain object from a Command message. Also converts values to other types if specified.
         * @function toObject
         * @memberof physical.Command
         * @static
         * @param {physical.Command} message Command
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Command.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.objects || options.defaults)
                object.parameters = {};
            if (options.defaults) {
                object.commandId = "";
                object.target = "";
                object.action = "";
                if ($util.Long) {
                    let long = new $util.Long(0, 0, false);
                    object.deadlineUnixMs = options.longs === $String ? long.toString() : options.longs === $Number ? long.toNumber() : typeof $BigInt !== "undefined" && options.longs === $BigInt ? long.toBigInt() : long;
                } else
                    object.deadlineUnixMs = options.longs === $String ? "0" : typeof $BigInt !== "undefined" && options.longs === $BigInt ? $BigInt("0") : 0;
            }
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId"))
                object.commandId = message.commandId;
            if (message.target != null && $Object.hasOwnProperty.call(message, "target"))
                object.target = message.target;
            if (message.action != null && $Object.hasOwnProperty.call(message, "action"))
                object.action = message.action;
            let keys2;
            if (message.parameters && (keys2 = $Object.keys(message.parameters)).length) {
                object.parameters = {};
                for (let j = 0; j < keys2.length; ++j) {
                    if (keys2[j] === "__proto__")
                        $util.makeProp(object.parameters, keys2[j]);
                    object.parameters[keys2[j]] = options.json && !$isFinite(message.parameters[keys2[j]]) ? $String(message.parameters[keys2[j]]) : message.parameters[keys2[j]];
                }
            }
            if (message.deadlineUnixMs != null && $Object.hasOwnProperty.call(message, "deadlineUnixMs"))
                if (typeof $BigInt !== "undefined" && options.longs === $BigInt)
                    object.deadlineUnixMs = typeof message.deadlineUnixMs === "number" ? $BigInt(message.deadlineUnixMs) : $util.Long.fromBits(message.deadlineUnixMs.low >>> 0, message.deadlineUnixMs.high >>> 0, false).toBigInt();
                else if (typeof message.deadlineUnixMs === "number")
                    object.deadlineUnixMs = options.longs === $String ? $String(message.deadlineUnixMs) : message.deadlineUnixMs;
                else
                    object.deadlineUnixMs = options.longs === $String ? $util.Long.prototype.toString.call(message.deadlineUnixMs) : options.longs === $Number ? new $util.LongBits(message.deadlineUnixMs.low >>> 0, message.deadlineUnixMs.high >>> 0).toNumber() : message.deadlineUnixMs;
            return object;
        };

        /**
         * Converts this Command to JSON.
         * @function toJSON
         * @memberof physical.Command
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Command.prototype.toJSON = function() {
            return Command.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for Command
         * @function getTypeUrl
         * @memberof physical.Command
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        Command.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/physical.Command";
        };

        return Command;
    })();

    physical.CancelCommandRequest = (function() {

        /**
         * Properties of a CancelCommandRequest.
         * @typedef {Object} physical.CancelCommandRequest.$Properties
         * @property {string|null} [commandId] CancelCommandRequest commandId
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */

        /**
         * Properties of a CancelCommandRequest.
         * @memberof physical
         * @interface ICancelCommandRequest
         * @augments physical.CancelCommandRequest.$Properties
         * @deprecated Use physical.CancelCommandRequest.$Properties instead.
         */

        /**
         * Shape of a CancelCommandRequest.
         * @typedef {physical.CancelCommandRequest.$Properties} physical.CancelCommandRequest.$Shape
         */

        /**
         * Constructs a new CancelCommandRequest.
         * @memberof physical
         * @classdesc Represents a CancelCommandRequest.
         * @constructor
         * @param {physical.CancelCommandRequest.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */
        const CancelCommandRequest = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * CancelCommandRequest commandId.
         * @member {string} commandId
         * @memberof physical.CancelCommandRequest
         * @instance
         */
        CancelCommandRequest.prototype.commandId = "";

        /**
         * Creates a new CancelCommandRequest instance using the specified properties.
         * @function create
         * @memberof physical.CancelCommandRequest
         * @static
         * @param {physical.CancelCommandRequest.$Properties=} [properties] Properties to set
         * @returns {physical.CancelCommandRequest} CancelCommandRequest instance
         * @type {{
         *   (properties: physical.CancelCommandRequest.$Shape): physical.CancelCommandRequest & physical.CancelCommandRequest.$Shape;
         *   (properties?: physical.CancelCommandRequest.$Properties): physical.CancelCommandRequest;
         * }}
         */
        CancelCommandRequest.create = function(properties) {
            return new CancelCommandRequest(properties);
        };

        /**
         * Encodes the specified CancelCommandRequest message. Does not implicitly {@link physical.CancelCommandRequest.verify|verify} messages.
         * @function encode
         * @memberof physical.CancelCommandRequest
         * @static
         * @param {physical.CancelCommandRequest.$Properties} message CancelCommandRequest message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CancelCommandRequest.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId") && message.commandId !== "")
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.commandId);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified CancelCommandRequest message, length delimited. Does not implicitly {@link physical.CancelCommandRequest.verify|verify} messages.
         * @function encodeDelimited
         * @memberof physical.CancelCommandRequest
         * @static
         * @param {physical.CancelCommandRequest.$Properties} message CancelCommandRequest message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CancelCommandRequest.encodeDelimited = function(message, writer) {
            return this.encode(message, (writer || $Writer.create()).fork()).ldelim();
        };

        /**
         * Decodes a CancelCommandRequest message from the specified reader or buffer.
         * @function decode
         * @memberof physical.CancelCommandRequest
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {physical.CancelCommandRequest & physical.CancelCommandRequest.$Shape} CancelCommandRequest
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CancelCommandRequest.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message, value;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.physical.CancelCommandRequest();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.commandId = value;
                        else
                            delete message.commandId;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a CancelCommandRequest message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof physical.CancelCommandRequest
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {physical.CancelCommandRequest & physical.CancelCommandRequest.$Shape} CancelCommandRequest
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CancelCommandRequest.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a CancelCommandRequest message.
         * @function verify
         * @memberof physical.CancelCommandRequest
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        CancelCommandRequest.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId"))
                if (!$util.isString(message.commandId))
                    return "commandId: string expected";
            return null;
        };

        /**
         * Creates a CancelCommandRequest message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof physical.CancelCommandRequest
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {physical.CancelCommandRequest} CancelCommandRequest
         */
        CancelCommandRequest.fromObject = function (object, _depth) {
            if (object instanceof $root.physical.CancelCommandRequest)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".physical.CancelCommandRequest: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.physical.CancelCommandRequest();
            if (object.commandId != null)
                if (typeof object.commandId !== "string" || object.commandId.length)
                    message.commandId = $String(object.commandId);
            return message;
        };

        /**
         * Creates a plain object from a CancelCommandRequest message. Also converts values to other types if specified.
         * @function toObject
         * @memberof physical.CancelCommandRequest
         * @static
         * @param {physical.CancelCommandRequest} message CancelCommandRequest
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        CancelCommandRequest.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults)
                object.commandId = "";
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId"))
                object.commandId = message.commandId;
            return object;
        };

        /**
         * Converts this CancelCommandRequest to JSON.
         * @function toJSON
         * @memberof physical.CancelCommandRequest
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        CancelCommandRequest.prototype.toJSON = function() {
            return CancelCommandRequest.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for CancelCommandRequest
         * @function getTypeUrl
         * @memberof physical.CancelCommandRequest
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        CancelCommandRequest.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/physical.CancelCommandRequest";
        };

        return CancelCommandRequest;
    })();

    physical.Rejection = (function() {

        /**
         * Properties of a Rejection.
         * @typedef {Object} physical.Rejection.$Properties
         * @property {string|null} [code] Rejection code
         * @property {string|null} [message] Rejection message
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */

        /**
         * Properties of a Rejection.
         * @memberof physical
         * @interface IRejection
         * @augments physical.Rejection.$Properties
         * @deprecated Use physical.Rejection.$Properties instead.
         */

        /**
         * Shape of a Rejection.
         * @typedef {physical.Rejection.$Properties} physical.Rejection.$Shape
         */

        /**
         * Constructs a new Rejection.
         * @memberof physical
         * @classdesc Represents a Rejection.
         * @constructor
         * @param {physical.Rejection.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */
        const Rejection = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * Rejection code.
         * @member {string} code
         * @memberof physical.Rejection
         * @instance
         */
        Rejection.prototype.code = "";

        /**
         * Rejection message.
         * @member {string} message
         * @memberof physical.Rejection
         * @instance
         */
        Rejection.prototype.message = "";

        /**
         * Creates a new Rejection instance using the specified properties.
         * @function create
         * @memberof physical.Rejection
         * @static
         * @param {physical.Rejection.$Properties=} [properties] Properties to set
         * @returns {physical.Rejection} Rejection instance
         * @type {{
         *   (properties: physical.Rejection.$Shape): physical.Rejection & physical.Rejection.$Shape;
         *   (properties?: physical.Rejection.$Properties): physical.Rejection;
         * }}
         */
        Rejection.create = function(properties) {
            return new Rejection(properties);
        };

        /**
         * Encodes the specified Rejection message. Does not implicitly {@link physical.Rejection.verify|verify} messages.
         * @function encode
         * @memberof physical.Rejection
         * @static
         * @param {physical.Rejection.$Properties} message Rejection message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Rejection.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.code != null && $Object.hasOwnProperty.call(message, "code") && message.code !== "")
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.code);
            if (message.message != null && $Object.hasOwnProperty.call(message, "message") && message.message !== "")
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.message);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified Rejection message, length delimited. Does not implicitly {@link physical.Rejection.verify|verify} messages.
         * @function encodeDelimited
         * @memberof physical.Rejection
         * @static
         * @param {physical.Rejection.$Properties} message Rejection message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Rejection.encodeDelimited = function(message, writer) {
            return this.encode(message, (writer || $Writer.create()).fork()).ldelim();
        };

        /**
         * Decodes a Rejection message from the specified reader or buffer.
         * @function decode
         * @memberof physical.Rejection
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {physical.Rejection & physical.Rejection.$Shape} Rejection
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Rejection.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message, value;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.physical.Rejection();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.code = value;
                        else
                            delete message.code;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.message = value;
                        else
                            delete message.message;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a Rejection message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof physical.Rejection
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {physical.Rejection & physical.Rejection.$Shape} Rejection
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Rejection.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Rejection message.
         * @function verify
         * @memberof physical.Rejection
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Rejection.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.code != null && $Object.hasOwnProperty.call(message, "code"))
                if (!$util.isString(message.code))
                    return "code: string expected";
            if (message.message != null && $Object.hasOwnProperty.call(message, "message"))
                if (!$util.isString(message.message))
                    return "message: string expected";
            return null;
        };

        /**
         * Creates a Rejection message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof physical.Rejection
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {physical.Rejection} Rejection
         */
        Rejection.fromObject = function (object, _depth) {
            if (object instanceof $root.physical.Rejection)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".physical.Rejection: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.physical.Rejection();
            if (object.code != null)
                if (typeof object.code !== "string" || object.code.length)
                    message.code = $String(object.code);
            if (object.message != null)
                if (typeof object.message !== "string" || object.message.length)
                    message.message = $String(object.message);
            return message;
        };

        /**
         * Creates a plain object from a Rejection message. Also converts values to other types if specified.
         * @function toObject
         * @memberof physical.Rejection
         * @static
         * @param {physical.Rejection} message Rejection
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Rejection.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.code = "";
                object.message = "";
            }
            if (message.code != null && $Object.hasOwnProperty.call(message, "code"))
                object.code = message.code;
            if (message.message != null && $Object.hasOwnProperty.call(message, "message"))
                object.message = message.message;
            return object;
        };

        /**
         * Converts this Rejection to JSON.
         * @function toJSON
         * @memberof physical.Rejection
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Rejection.prototype.toJSON = function() {
            return Rejection.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for Rejection
         * @function getTypeUrl
         * @memberof physical.Rejection
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        Rejection.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/physical.Rejection";
        };

        return Rejection;
    })();

    physical.Failure = (function() {

        /**
         * Properties of a Failure.
         * @typedef {Object} physical.Failure.$Properties
         * @property {string|null} [code] Failure code
         * @property {string|null} [message] Failure message
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */

        /**
         * Properties of a Failure.
         * @memberof physical
         * @interface IFailure
         * @augments physical.Failure.$Properties
         * @deprecated Use physical.Failure.$Properties instead.
         */

        /**
         * Shape of a Failure.
         * @typedef {physical.Failure.$Properties} physical.Failure.$Shape
         */

        /**
         * Constructs a new Failure.
         * @memberof physical
         * @classdesc Represents a Failure.
         * @constructor
         * @param {physical.Failure.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */
        const Failure = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * Failure code.
         * @member {string} code
         * @memberof physical.Failure
         * @instance
         */
        Failure.prototype.code = "";

        /**
         * Failure message.
         * @member {string} message
         * @memberof physical.Failure
         * @instance
         */
        Failure.prototype.message = "";

        /**
         * Creates a new Failure instance using the specified properties.
         * @function create
         * @memberof physical.Failure
         * @static
         * @param {physical.Failure.$Properties=} [properties] Properties to set
         * @returns {physical.Failure} Failure instance
         * @type {{
         *   (properties: physical.Failure.$Shape): physical.Failure & physical.Failure.$Shape;
         *   (properties?: physical.Failure.$Properties): physical.Failure;
         * }}
         */
        Failure.create = function(properties) {
            return new Failure(properties);
        };

        /**
         * Encodes the specified Failure message. Does not implicitly {@link physical.Failure.verify|verify} messages.
         * @function encode
         * @memberof physical.Failure
         * @static
         * @param {physical.Failure.$Properties} message Failure message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Failure.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.code != null && $Object.hasOwnProperty.call(message, "code") && message.code !== "")
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.code);
            if (message.message != null && $Object.hasOwnProperty.call(message, "message") && message.message !== "")
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.message);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified Failure message, length delimited. Does not implicitly {@link physical.Failure.verify|verify} messages.
         * @function encodeDelimited
         * @memberof physical.Failure
         * @static
         * @param {physical.Failure.$Properties} message Failure message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Failure.encodeDelimited = function(message, writer) {
            return this.encode(message, (writer || $Writer.create()).fork()).ldelim();
        };

        /**
         * Decodes a Failure message from the specified reader or buffer.
         * @function decode
         * @memberof physical.Failure
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {physical.Failure & physical.Failure.$Shape} Failure
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Failure.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message, value;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.physical.Failure();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.code = value;
                        else
                            delete message.code;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.message = value;
                        else
                            delete message.message;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a Failure message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof physical.Failure
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {physical.Failure & physical.Failure.$Shape} Failure
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Failure.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Failure message.
         * @function verify
         * @memberof physical.Failure
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Failure.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.code != null && $Object.hasOwnProperty.call(message, "code"))
                if (!$util.isString(message.code))
                    return "code: string expected";
            if (message.message != null && $Object.hasOwnProperty.call(message, "message"))
                if (!$util.isString(message.message))
                    return "message: string expected";
            return null;
        };

        /**
         * Creates a Failure message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof physical.Failure
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {physical.Failure} Failure
         */
        Failure.fromObject = function (object, _depth) {
            if (object instanceof $root.physical.Failure)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".physical.Failure: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.physical.Failure();
            if (object.code != null)
                if (typeof object.code !== "string" || object.code.length)
                    message.code = $String(object.code);
            if (object.message != null)
                if (typeof object.message !== "string" || object.message.length)
                    message.message = $String(object.message);
            return message;
        };

        /**
         * Creates a plain object from a Failure message. Also converts values to other types if specified.
         * @function toObject
         * @memberof physical.Failure
         * @static
         * @param {physical.Failure} message Failure
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Failure.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.code = "";
                object.message = "";
            }
            if (message.code != null && $Object.hasOwnProperty.call(message, "code"))
                object.code = message.code;
            if (message.message != null && $Object.hasOwnProperty.call(message, "message"))
                object.message = message.message;
            return object;
        };

        /**
         * Converts this Failure to JSON.
         * @function toJSON
         * @memberof physical.Failure
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Failure.prototype.toJSON = function() {
            return Failure.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for Failure
         * @function getTypeUrl
         * @memberof physical.Failure
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        Failure.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/physical.Failure";
        };

        return Failure;
    })();

    physical.CommandAcceptance = (function() {

        /**
         * Properties of a CommandAcceptance.
         * @typedef {Object} physical.CommandAcceptance.$Properties
         * @property {string|null} [commandId] CommandAcceptance commandId
         * @property {boolean|null} [accepted] CommandAcceptance accepted
         * @property {physical.Rejection.$Properties|null} [rejection] CommandAcceptance rejection
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */

        /**
         * Properties of a CommandAcceptance.
         * @memberof physical
         * @interface ICommandAcceptance
         * @augments physical.CommandAcceptance.$Properties
         * @deprecated Use physical.CommandAcceptance.$Properties instead.
         */

        /**
         * Shape of a CommandAcceptance.
         * @typedef {physical.CommandAcceptance.$Properties} physical.CommandAcceptance.$Shape
         */

        /**
         * Constructs a new CommandAcceptance.
         * @memberof physical
         * @classdesc Represents a CommandAcceptance.
         * @constructor
         * @param {physical.CommandAcceptance.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */
        const CommandAcceptance = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * CommandAcceptance commandId.
         * @member {string} commandId
         * @memberof physical.CommandAcceptance
         * @instance
         */
        CommandAcceptance.prototype.commandId = "";

        /**
         * CommandAcceptance accepted.
         * @member {boolean} accepted
         * @memberof physical.CommandAcceptance
         * @instance
         */
        CommandAcceptance.prototype.accepted = false;

        /**
         * CommandAcceptance rejection.
         * @member {physical.Rejection.$Properties|null|undefined} rejection
         * @memberof physical.CommandAcceptance
         * @instance
         */
        CommandAcceptance.prototype.rejection = null;

        /**
         * Creates a new CommandAcceptance instance using the specified properties.
         * @function create
         * @memberof physical.CommandAcceptance
         * @static
         * @param {physical.CommandAcceptance.$Properties=} [properties] Properties to set
         * @returns {physical.CommandAcceptance} CommandAcceptance instance
         * @type {{
         *   (properties: physical.CommandAcceptance.$Shape): physical.CommandAcceptance & physical.CommandAcceptance.$Shape;
         *   (properties?: physical.CommandAcceptance.$Properties): physical.CommandAcceptance;
         * }}
         */
        CommandAcceptance.create = function(properties) {
            return new CommandAcceptance(properties);
        };

        /**
         * Encodes the specified CommandAcceptance message. Does not implicitly {@link physical.CommandAcceptance.verify|verify} messages.
         * @function encode
         * @memberof physical.CommandAcceptance
         * @static
         * @param {physical.CommandAcceptance.$Properties} message CommandAcceptance message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CommandAcceptance.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId") && message.commandId !== "")
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.commandId);
            if (message.accepted != null && $Object.hasOwnProperty.call(message, "accepted") && message.accepted !== false)
                writer.uint32(/* id 2, wireType 0 =*/16).bool(message.accepted);
            if (message.rejection != null && $Object.hasOwnProperty.call(message, "rejection"))
                $root.physical.Rejection.encode(message.rejection, writer.uint32(/* id 3, wireType 2 =*/26).fork(), _depth + 1).ldelim();
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified CommandAcceptance message, length delimited. Does not implicitly {@link physical.CommandAcceptance.verify|verify} messages.
         * @function encodeDelimited
         * @memberof physical.CommandAcceptance
         * @static
         * @param {physical.CommandAcceptance.$Properties} message CommandAcceptance message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CommandAcceptance.encodeDelimited = function(message, writer) {
            return this.encode(message, (writer || $Writer.create()).fork()).ldelim();
        };

        /**
         * Decodes a CommandAcceptance message from the specified reader or buffer.
         * @function decode
         * @memberof physical.CommandAcceptance
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {physical.CommandAcceptance & physical.CommandAcceptance.$Shape} CommandAcceptance
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CommandAcceptance.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message, value;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.physical.CommandAcceptance();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.commandId = value;
                        else
                            delete message.commandId;
                        continue;
                    }
                case 2: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.bool())
                            message.accepted = value;
                        else
                            delete message.accepted;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        message.rejection = $root.physical.Rejection.decode(reader, reader.uint32(), $undefined, _depth + 1, message.rejection);
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a CommandAcceptance message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof physical.CommandAcceptance
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {physical.CommandAcceptance & physical.CommandAcceptance.$Shape} CommandAcceptance
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CommandAcceptance.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a CommandAcceptance message.
         * @function verify
         * @memberof physical.CommandAcceptance
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        CommandAcceptance.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId"))
                if (!$util.isString(message.commandId))
                    return "commandId: string expected";
            if (message.accepted != null && $Object.hasOwnProperty.call(message, "accepted"))
                if (typeof message.accepted !== "boolean")
                    return "accepted: boolean expected";
            if (message.rejection != null && $Object.hasOwnProperty.call(message, "rejection")) {
                let error = $root.physical.Rejection.verify(message.rejection, _depth + 1);
                if (error)
                    return "rejection." + error;
            }
            return null;
        };

        /**
         * Creates a CommandAcceptance message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof physical.CommandAcceptance
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {physical.CommandAcceptance} CommandAcceptance
         */
        CommandAcceptance.fromObject = function (object, _depth) {
            if (object instanceof $root.physical.CommandAcceptance)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".physical.CommandAcceptance: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.physical.CommandAcceptance();
            if (object.commandId != null)
                if (typeof object.commandId !== "string" || object.commandId.length)
                    message.commandId = $String(object.commandId);
            if (object.accepted != null)
                if (object.accepted)
                    message.accepted = $Boolean(object.accepted);
            if (object.rejection != null) {
                if (!$util.isObject(object.rejection))
                    throw $TypeError(".physical.CommandAcceptance.rejection: object expected");
                message.rejection = $root.physical.Rejection.fromObject(object.rejection, _depth + 1);
            }
            return message;
        };

        /**
         * Creates a plain object from a CommandAcceptance message. Also converts values to other types if specified.
         * @function toObject
         * @memberof physical.CommandAcceptance
         * @static
         * @param {physical.CommandAcceptance} message CommandAcceptance
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        CommandAcceptance.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.commandId = "";
                object.accepted = false;
                object.rejection = null;
            }
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId"))
                object.commandId = message.commandId;
            if (message.accepted != null && $Object.hasOwnProperty.call(message, "accepted"))
                object.accepted = message.accepted;
            if (message.rejection != null && $Object.hasOwnProperty.call(message, "rejection"))
                object.rejection = $root.physical.Rejection.toObject(message.rejection, options, _depth + 1);
            return object;
        };

        /**
         * Converts this CommandAcceptance to JSON.
         * @function toJSON
         * @memberof physical.CommandAcceptance
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        CommandAcceptance.prototype.toJSON = function() {
            return CommandAcceptance.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for CommandAcceptance
         * @function getTypeUrl
         * @memberof physical.CommandAcceptance
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        CommandAcceptance.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/physical.CommandAcceptance";
        };

        return CommandAcceptance;
    })();

    physical.CommandStatus = (function() {

        /**
         * Properties of a CommandStatus.
         * @typedef {Object} physical.CommandStatus.$Properties
         * @property {string|null} [commandId] CommandStatus commandId
         * @property {string|null} [state] CommandStatus state
         * @property {string|null} [detail] CommandStatus detail
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */

        /**
         * Properties of a CommandStatus.
         * @memberof physical
         * @interface ICommandStatus
         * @augments physical.CommandStatus.$Properties
         * @deprecated Use physical.CommandStatus.$Properties instead.
         */

        /**
         * Shape of a CommandStatus.
         * @typedef {physical.CommandStatus.$Properties} physical.CommandStatus.$Shape
         */

        /**
         * Constructs a new CommandStatus.
         * @memberof physical
         * @classdesc Represents a CommandStatus.
         * @constructor
         * @param {physical.CommandStatus.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */
        const CommandStatus = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * CommandStatus commandId.
         * @member {string} commandId
         * @memberof physical.CommandStatus
         * @instance
         */
        CommandStatus.prototype.commandId = "";

        /**
         * CommandStatus state.
         * @member {string} state
         * @memberof physical.CommandStatus
         * @instance
         */
        CommandStatus.prototype.state = "";

        /**
         * CommandStatus detail.
         * @member {string} detail
         * @memberof physical.CommandStatus
         * @instance
         */
        CommandStatus.prototype.detail = "";

        /**
         * Creates a new CommandStatus instance using the specified properties.
         * @function create
         * @memberof physical.CommandStatus
         * @static
         * @param {physical.CommandStatus.$Properties=} [properties] Properties to set
         * @returns {physical.CommandStatus} CommandStatus instance
         * @type {{
         *   (properties: physical.CommandStatus.$Shape): physical.CommandStatus & physical.CommandStatus.$Shape;
         *   (properties?: physical.CommandStatus.$Properties): physical.CommandStatus;
         * }}
         */
        CommandStatus.create = function(properties) {
            return new CommandStatus(properties);
        };

        /**
         * Encodes the specified CommandStatus message. Does not implicitly {@link physical.CommandStatus.verify|verify} messages.
         * @function encode
         * @memberof physical.CommandStatus
         * @static
         * @param {physical.CommandStatus.$Properties} message CommandStatus message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CommandStatus.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId") && message.commandId !== "")
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.commandId);
            if (message.state != null && $Object.hasOwnProperty.call(message, "state") && message.state !== "")
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.state);
            if (message.detail != null && $Object.hasOwnProperty.call(message, "detail") && message.detail !== "")
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.detail);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified CommandStatus message, length delimited. Does not implicitly {@link physical.CommandStatus.verify|verify} messages.
         * @function encodeDelimited
         * @memberof physical.CommandStatus
         * @static
         * @param {physical.CommandStatus.$Properties} message CommandStatus message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CommandStatus.encodeDelimited = function(message, writer) {
            return this.encode(message, (writer || $Writer.create()).fork()).ldelim();
        };

        /**
         * Decodes a CommandStatus message from the specified reader or buffer.
         * @function decode
         * @memberof physical.CommandStatus
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {physical.CommandStatus & physical.CommandStatus.$Shape} CommandStatus
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CommandStatus.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message, value;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.physical.CommandStatus();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.commandId = value;
                        else
                            delete message.commandId;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.state = value;
                        else
                            delete message.state;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.detail = value;
                        else
                            delete message.detail;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a CommandStatus message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof physical.CommandStatus
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {physical.CommandStatus & physical.CommandStatus.$Shape} CommandStatus
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CommandStatus.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a CommandStatus message.
         * @function verify
         * @memberof physical.CommandStatus
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        CommandStatus.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId"))
                if (!$util.isString(message.commandId))
                    return "commandId: string expected";
            if (message.state != null && $Object.hasOwnProperty.call(message, "state"))
                if (!$util.isString(message.state))
                    return "state: string expected";
            if (message.detail != null && $Object.hasOwnProperty.call(message, "detail"))
                if (!$util.isString(message.detail))
                    return "detail: string expected";
            return null;
        };

        /**
         * Creates a CommandStatus message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof physical.CommandStatus
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {physical.CommandStatus} CommandStatus
         */
        CommandStatus.fromObject = function (object, _depth) {
            if (object instanceof $root.physical.CommandStatus)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".physical.CommandStatus: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.physical.CommandStatus();
            if (object.commandId != null)
                if (typeof object.commandId !== "string" || object.commandId.length)
                    message.commandId = $String(object.commandId);
            if (object.state != null)
                if (typeof object.state !== "string" || object.state.length)
                    message.state = $String(object.state);
            if (object.detail != null)
                if (typeof object.detail !== "string" || object.detail.length)
                    message.detail = $String(object.detail);
            return message;
        };

        /**
         * Creates a plain object from a CommandStatus message. Also converts values to other types if specified.
         * @function toObject
         * @memberof physical.CommandStatus
         * @static
         * @param {physical.CommandStatus} message CommandStatus
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        CommandStatus.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.commandId = "";
                object.state = "";
                object.detail = "";
            }
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId"))
                object.commandId = message.commandId;
            if (message.state != null && $Object.hasOwnProperty.call(message, "state"))
                object.state = message.state;
            if (message.detail != null && $Object.hasOwnProperty.call(message, "detail"))
                object.detail = message.detail;
            return object;
        };

        /**
         * Converts this CommandStatus to JSON.
         * @function toJSON
         * @memberof physical.CommandStatus
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        CommandStatus.prototype.toJSON = function() {
            return CommandStatus.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for CommandStatus
         * @function getTypeUrl
         * @memberof physical.CommandStatus
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        CommandStatus.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/physical.CommandStatus";
        };

        return CommandStatus;
    })();

    physical.CommandResult = (function() {

        /**
         * Properties of a CommandResult.
         * @typedef {Object} physical.CommandResult.$Properties
         * @property {string|null} [commandId] CommandResult commandId
         * @property {physical.TerminalStatus|null} [status] CommandResult status
         * @property {Object.<string,number>|null} [result] CommandResult result
         * @property {physical.Failure.$Properties|null} [failure] CommandResult failure
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */

        /**
         * Properties of a CommandResult.
         * @memberof physical
         * @interface ICommandResult
         * @augments physical.CommandResult.$Properties
         * @deprecated Use physical.CommandResult.$Properties instead.
         */

        /**
         * Shape of a CommandResult.
         * @typedef {physical.CommandResult.$Properties} physical.CommandResult.$Shape
         */

        /**
         * Constructs a new CommandResult.
         * @memberof physical
         * @classdesc Represents a CommandResult.
         * @constructor
         * @param {physical.CommandResult.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */
        const CommandResult = function (properties) {
            this.result = {};
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * CommandResult commandId.
         * @member {string} commandId
         * @memberof physical.CommandResult
         * @instance
         */
        CommandResult.prototype.commandId = "";

        /**
         * CommandResult status.
         * @member {physical.TerminalStatus} status
         * @memberof physical.CommandResult
         * @instance
         */
        CommandResult.prototype.status = 0;

        /**
         * CommandResult result.
         * @member {Object.<string,number>} result
         * @memberof physical.CommandResult
         * @instance
         */
        CommandResult.prototype.result = $util.emptyObject;

        /**
         * CommandResult failure.
         * @member {physical.Failure.$Properties|null|undefined} failure
         * @memberof physical.CommandResult
         * @instance
         */
        CommandResult.prototype.failure = null;

        /**
         * Creates a new CommandResult instance using the specified properties.
         * @function create
         * @memberof physical.CommandResult
         * @static
         * @param {physical.CommandResult.$Properties=} [properties] Properties to set
         * @returns {physical.CommandResult} CommandResult instance
         * @type {{
         *   (properties: physical.CommandResult.$Shape): physical.CommandResult & physical.CommandResult.$Shape;
         *   (properties?: physical.CommandResult.$Properties): physical.CommandResult;
         * }}
         */
        CommandResult.create = function(properties) {
            return new CommandResult(properties);
        };

        /**
         * Encodes the specified CommandResult message. Does not implicitly {@link physical.CommandResult.verify|verify} messages.
         * @function encode
         * @memberof physical.CommandResult
         * @static
         * @param {physical.CommandResult.$Properties} message CommandResult message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CommandResult.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId") && message.commandId !== "")
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.commandId);
            if (message.status != null && $Object.hasOwnProperty.call(message, "status") && message.status !== 0)
                writer.uint32(/* id 2, wireType 0 =*/16).int32(message.status);
            if (message.result != null && $Object.hasOwnProperty.call(message, "result"))
                for (let keys = $Object.keys(message.result), i = 0; i < keys.length; ++i)
                    writer.uint32(/* id 3, wireType 2 =*/26).fork().uint32(/* id 1, wireType 2 =*/10).string(keys[i]).uint32(/* id 2, wireType 1 =*/17).double(message.result[keys[i]]).ldelim();
            if (message.failure != null && $Object.hasOwnProperty.call(message, "failure"))
                $root.physical.Failure.encode(message.failure, writer.uint32(/* id 4, wireType 2 =*/34).fork(), _depth + 1).ldelim();
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified CommandResult message, length delimited. Does not implicitly {@link physical.CommandResult.verify|verify} messages.
         * @function encodeDelimited
         * @memberof physical.CommandResult
         * @static
         * @param {physical.CommandResult.$Properties} message CommandResult message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CommandResult.encodeDelimited = function(message, writer) {
            return this.encode(message, (writer || $Writer.create()).fork()).ldelim();
        };

        /**
         * Decodes a CommandResult message from the specified reader or buffer.
         * @function decode
         * @memberof physical.CommandResult
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {physical.CommandResult & physical.CommandResult.$Shape} CommandResult
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CommandResult.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message, key, value;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.physical.CommandResult();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.commandId = value;
                        else
                            delete message.commandId;
                        continue;
                    }
                case 2: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.int32())
                            message.status = value;
                        else
                            delete message.status;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if (message.result === $util.emptyObject)
                            message.result = {};
                        let end2 = reader.uint32() + reader.pos;
                        if (end2 > reader.len)
                            throw $RangeError("index out of range");
                        reader.len = end2;
                        key = "";
                        value = 0;
                        while (reader.pos < end2) {
                            let tag2 = reader.tag();
                            wireType = tag2 & 7;
                            switch (tag2 >>>= 3) {
                            case 1:
                                if (wireType !== 2)
                                    break;
                                key = reader.stringVerify();
                                continue;
                            case 2:
                                if (wireType !== 1)
                                    break;
                                value = reader.double();
                                continue;
                            }
                            reader.skipType(wireType, _depth, tag2);
                        }
                        if (reader.pos !== end2)
                            throw $RangeError("index out of range");
                        reader.len = end;
                        if (key === "__proto__")
                            $util.makeProp(message.result, key);
                        message.result[key] = value;
                        continue;
                    }
                case 4: {
                        if (wireType !== 2)
                            break;
                        message.failure = $root.physical.Failure.decode(reader, reader.uint32(), $undefined, _depth + 1, message.failure);
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a CommandResult message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof physical.CommandResult
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {physical.CommandResult & physical.CommandResult.$Shape} CommandResult
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CommandResult.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a CommandResult message.
         * @function verify
         * @memberof physical.CommandResult
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        CommandResult.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId"))
                if (!$util.isString(message.commandId))
                    return "commandId: string expected";
            if (message.status != null && $Object.hasOwnProperty.call(message, "status"))
                if (typeof message.status !== "number" || (message.status | 0) !== message.status)
                    return "status: enum value expected";
            if (message.result != null && $Object.hasOwnProperty.call(message, "result")) {
                if (!$util.isObject(message.result))
                    return "result: object expected";
                let key = $Object.keys(message.result);
                for (let i = 0; i < key.length; ++i)
                    if (typeof message.result[key[i]] !== "number")
                        return "result: number{k:string} expected";
            }
            if (message.failure != null && $Object.hasOwnProperty.call(message, "failure")) {
                let error = $root.physical.Failure.verify(message.failure, _depth + 1);
                if (error)
                    return "failure." + error;
            }
            return null;
        };

        /**
         * Creates a CommandResult message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof physical.CommandResult
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {physical.CommandResult} CommandResult
         */
        CommandResult.fromObject = function (object, _depth) {
            if (object instanceof $root.physical.CommandResult)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".physical.CommandResult: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.physical.CommandResult();
            if (object.commandId != null)
                if (typeof object.commandId !== "string" || object.commandId.length)
                    message.commandId = $String(object.commandId);
            if (object.status !== 0 && (typeof object.status !== "string" || $root.physical.TerminalStatus[object.status] !== 0))
                switch (object.status) {
                case "TERMINAL_STATUS_UNSPECIFIED":
                case 0:
                    message.status = 0;
                    break;
                case "SUCCEEDED":
                case 1:
                    message.status = 1;
                    break;
                case "ABORTED":
                case 2:
                    message.status = 2;
                    break;
                case "CANCELED":
                case 3:
                    message.status = 3;
                    break;
                default:
                    if (typeof object.status === "number" && (object.status | 0) === object.status)
                        message.status = object.status;
                }
            if (object.result) {
                if (!$util.isObject(object.result))
                    throw $TypeError(".physical.CommandResult.result: object expected");
                message.result = {};
                for (let keys = $Object.keys(object.result), i = 0; i < keys.length; ++i) {
                    if (keys[i] === "__proto__")
                        $util.makeProp(message.result, keys[i]);
                    message.result[keys[i]] = $Number(object.result[keys[i]]);
                }
            }
            if (object.failure != null) {
                if (!$util.isObject(object.failure))
                    throw $TypeError(".physical.CommandResult.failure: object expected");
                message.failure = $root.physical.Failure.fromObject(object.failure, _depth + 1);
            }
            return message;
        };

        /**
         * Creates a plain object from a CommandResult message. Also converts values to other types if specified.
         * @function toObject
         * @memberof physical.CommandResult
         * @static
         * @param {physical.CommandResult} message CommandResult
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        CommandResult.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.objects || options.defaults)
                object.result = {};
            if (options.defaults) {
                object.commandId = "";
                object.status = options.enums === $String ? "TERMINAL_STATUS_UNSPECIFIED" : 0;
                object.failure = null;
            }
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId"))
                object.commandId = message.commandId;
            if (message.status != null && $Object.hasOwnProperty.call(message, "status"))
                object.status = options.enums === $String ? $root.physical.TerminalStatus[message.status] === $undefined ? message.status : $root.physical.TerminalStatus[message.status] : message.status;
            let keys2;
            if (message.result && (keys2 = $Object.keys(message.result)).length) {
                object.result = {};
                for (let j = 0; j < keys2.length; ++j) {
                    if (keys2[j] === "__proto__")
                        $util.makeProp(object.result, keys2[j]);
                    object.result[keys2[j]] = options.json && !$isFinite(message.result[keys2[j]]) ? $String(message.result[keys2[j]]) : message.result[keys2[j]];
                }
            }
            if (message.failure != null && $Object.hasOwnProperty.call(message, "failure"))
                object.failure = $root.physical.Failure.toObject(message.failure, options, _depth + 1);
            return object;
        };

        /**
         * Converts this CommandResult to JSON.
         * @function toJSON
         * @memberof physical.CommandResult
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        CommandResult.prototype.toJSON = function() {
            return CommandResult.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for CommandResult
         * @function getTypeUrl
         * @memberof physical.CommandResult
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        CommandResult.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/physical.CommandResult";
        };

        return CommandResult;
    })();

    physical.CancelCommandResponse = (function() {

        /**
         * Properties of a CancelCommandResponse.
         * @typedef {Object} physical.CancelCommandResponse.$Properties
         * @property {string|null} [commandId] CancelCommandResponse commandId
         * @property {boolean|null} [accepted] CancelCommandResponse accepted
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */

        /**
         * Properties of a CancelCommandResponse.
         * @memberof physical
         * @interface ICancelCommandResponse
         * @augments physical.CancelCommandResponse.$Properties
         * @deprecated Use physical.CancelCommandResponse.$Properties instead.
         */

        /**
         * Shape of a CancelCommandResponse.
         * @typedef {physical.CancelCommandResponse.$Properties} physical.CancelCommandResponse.$Shape
         */

        /**
         * Constructs a new CancelCommandResponse.
         * @memberof physical
         * @classdesc Represents a CancelCommandResponse.
         * @constructor
         * @param {physical.CancelCommandResponse.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */
        const CancelCommandResponse = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * CancelCommandResponse commandId.
         * @member {string} commandId
         * @memberof physical.CancelCommandResponse
         * @instance
         */
        CancelCommandResponse.prototype.commandId = "";

        /**
         * CancelCommandResponse accepted.
         * @member {boolean} accepted
         * @memberof physical.CancelCommandResponse
         * @instance
         */
        CancelCommandResponse.prototype.accepted = false;

        /**
         * Creates a new CancelCommandResponse instance using the specified properties.
         * @function create
         * @memberof physical.CancelCommandResponse
         * @static
         * @param {physical.CancelCommandResponse.$Properties=} [properties] Properties to set
         * @returns {physical.CancelCommandResponse} CancelCommandResponse instance
         * @type {{
         *   (properties: physical.CancelCommandResponse.$Shape): physical.CancelCommandResponse & physical.CancelCommandResponse.$Shape;
         *   (properties?: physical.CancelCommandResponse.$Properties): physical.CancelCommandResponse;
         * }}
         */
        CancelCommandResponse.create = function(properties) {
            return new CancelCommandResponse(properties);
        };

        /**
         * Encodes the specified CancelCommandResponse message. Does not implicitly {@link physical.CancelCommandResponse.verify|verify} messages.
         * @function encode
         * @memberof physical.CancelCommandResponse
         * @static
         * @param {physical.CancelCommandResponse.$Properties} message CancelCommandResponse message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CancelCommandResponse.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId") && message.commandId !== "")
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.commandId);
            if (message.accepted != null && $Object.hasOwnProperty.call(message, "accepted") && message.accepted !== false)
                writer.uint32(/* id 2, wireType 0 =*/16).bool(message.accepted);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified CancelCommandResponse message, length delimited. Does not implicitly {@link physical.CancelCommandResponse.verify|verify} messages.
         * @function encodeDelimited
         * @memberof physical.CancelCommandResponse
         * @static
         * @param {physical.CancelCommandResponse.$Properties} message CancelCommandResponse message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CancelCommandResponse.encodeDelimited = function(message, writer) {
            return this.encode(message, (writer || $Writer.create()).fork()).ldelim();
        };

        /**
         * Decodes a CancelCommandResponse message from the specified reader or buffer.
         * @function decode
         * @memberof physical.CancelCommandResponse
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {physical.CancelCommandResponse & physical.CancelCommandResponse.$Shape} CancelCommandResponse
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CancelCommandResponse.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message, value;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.physical.CancelCommandResponse();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.commandId = value;
                        else
                            delete message.commandId;
                        continue;
                    }
                case 2: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.bool())
                            message.accepted = value;
                        else
                            delete message.accepted;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a CancelCommandResponse message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof physical.CancelCommandResponse
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {physical.CancelCommandResponse & physical.CancelCommandResponse.$Shape} CancelCommandResponse
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CancelCommandResponse.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a CancelCommandResponse message.
         * @function verify
         * @memberof physical.CancelCommandResponse
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        CancelCommandResponse.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId"))
                if (!$util.isString(message.commandId))
                    return "commandId: string expected";
            if (message.accepted != null && $Object.hasOwnProperty.call(message, "accepted"))
                if (typeof message.accepted !== "boolean")
                    return "accepted: boolean expected";
            return null;
        };

        /**
         * Creates a CancelCommandResponse message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof physical.CancelCommandResponse
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {physical.CancelCommandResponse} CancelCommandResponse
         */
        CancelCommandResponse.fromObject = function (object, _depth) {
            if (object instanceof $root.physical.CancelCommandResponse)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".physical.CancelCommandResponse: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.physical.CancelCommandResponse();
            if (object.commandId != null)
                if (typeof object.commandId !== "string" || object.commandId.length)
                    message.commandId = $String(object.commandId);
            if (object.accepted != null)
                if (object.accepted)
                    message.accepted = $Boolean(object.accepted);
            return message;
        };

        /**
         * Creates a plain object from a CancelCommandResponse message. Also converts values to other types if specified.
         * @function toObject
         * @memberof physical.CancelCommandResponse
         * @static
         * @param {physical.CancelCommandResponse} message CancelCommandResponse
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        CancelCommandResponse.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.defaults) {
                object.commandId = "";
                object.accepted = false;
            }
            if (message.commandId != null && $Object.hasOwnProperty.call(message, "commandId"))
                object.commandId = message.commandId;
            if (message.accepted != null && $Object.hasOwnProperty.call(message, "accepted"))
                object.accepted = message.accepted;
            return object;
        };

        /**
         * Converts this CancelCommandResponse to JSON.
         * @function toJSON
         * @memberof physical.CancelCommandResponse
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        CancelCommandResponse.prototype.toJSON = function() {
            return CancelCommandResponse.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for CancelCommandResponse
         * @function getTypeUrl
         * @memberof physical.CancelCommandResponse
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        CancelCommandResponse.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/physical.CancelCommandResponse";
        };

        return CancelCommandResponse;
    })();

    physical.Capability = (function() {

        /**
         * Properties of a Capability.
         * @typedef {Object} physical.Capability.$Properties
         * @property {string|null} [deviceId] Capability deviceId
         * @property {Array.<string>|null} [actions] Capability actions
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */

        /**
         * Properties of a Capability.
         * @memberof physical
         * @interface ICapability
         * @augments physical.Capability.$Properties
         * @deprecated Use physical.Capability.$Properties instead.
         */

        /**
         * Shape of a Capability.
         * @typedef {physical.Capability.$Properties} physical.Capability.$Shape
         */

        /**
         * Constructs a new Capability.
         * @memberof physical
         * @classdesc Represents a Capability.
         * @constructor
         * @param {physical.Capability.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding when enabled
         */
        const Capability = function (properties) {
            this.actions = [];
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        /**
         * Capability deviceId.
         * @member {string} deviceId
         * @memberof physical.Capability
         * @instance
         */
        Capability.prototype.deviceId = "";

        /**
         * Capability actions.
         * @member {Array.<string>} actions
         * @memberof physical.Capability
         * @instance
         */
        Capability.prototype.actions = $util.emptyArray;

        /**
         * Creates a new Capability instance using the specified properties.
         * @function create
         * @memberof physical.Capability
         * @static
         * @param {physical.Capability.$Properties=} [properties] Properties to set
         * @returns {physical.Capability} Capability instance
         * @type {{
         *   (properties: physical.Capability.$Shape): physical.Capability & physical.Capability.$Shape;
         *   (properties?: physical.Capability.$Properties): physical.Capability;
         * }}
         */
        Capability.create = function(properties) {
            return new Capability(properties);
        };

        /**
         * Encodes the specified Capability message. Does not implicitly {@link physical.Capability.verify|verify} messages.
         * @function encode
         * @memberof physical.Capability
         * @static
         * @param {physical.Capability.$Properties} message Capability message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Capability.encode = function (message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            if (message.deviceId != null && $Object.hasOwnProperty.call(message, "deviceId") && message.deviceId !== "")
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.deviceId);
            if (message.actions != null && message.actions.length)
                for (let i = 0; i < message.actions.length; ++i)
                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.actions[i]);
            if (message.$unknowns != null && $Object.hasOwnProperty.call(message, "$unknowns"))
                for (let i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified Capability message, length delimited. Does not implicitly {@link physical.Capability.verify|verify} messages.
         * @function encodeDelimited
         * @memberof physical.Capability
         * @static
         * @param {physical.Capability.$Properties} message Capability message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Capability.encodeDelimited = function(message, writer) {
            return this.encode(message, (writer || $Writer.create()).fork()).ldelim();
        };

        /**
         * Decodes a Capability message from the specified reader or buffer.
         * @function decode
         * @memberof physical.Capability
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {physical.Capability & physical.Capability.$Shape} Capability
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Capability.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message, value;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.physical.Capability();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.stringVerify()).length)
                            message.deviceId = value;
                        else
                            delete message.deviceId;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if (!(message.actions && message.actions.length))
                            message.actions = [];
                        message.actions.push(reader.stringVerify());
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        /**
         * Decodes a Capability message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof physical.Capability
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {physical.Capability & physical.Capability.$Shape} Capability
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Capability.decodeDelimited = function(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Capability message.
         * @function verify
         * @memberof physical.Capability
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Capability.verify = function (message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.deviceId != null && $Object.hasOwnProperty.call(message, "deviceId"))
                if (!$util.isString(message.deviceId))
                    return "deviceId: string expected";
            if (message.actions != null && $Object.hasOwnProperty.call(message, "actions")) {
                if (!$Array.isArray(message.actions))
                    return "actions: array expected";
                for (let i = 0; i < message.actions.length; ++i)
                    if (!$util.isString(message.actions[i]))
                        return "actions: string[] expected";
            }
            return null;
        };

        /**
         * Creates a Capability message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof physical.Capability
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {physical.Capability} Capability
         */
        Capability.fromObject = function (object, _depth) {
            if (object instanceof $root.physical.Capability)
                return object;
            if (!$util.isObject(object))
                throw $TypeError(".physical.Capability: object expected");
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let message = new $root.physical.Capability();
            if (object.deviceId != null)
                if (typeof object.deviceId !== "string" || object.deviceId.length)
                    message.deviceId = $String(object.deviceId);
            if (object.actions) {
                if (!$Array.isArray(object.actions))
                    throw $TypeError(".physical.Capability.actions: array expected");
                message.actions = $Array(object.actions.length);
                for (let i = 0; i < object.actions.length; ++i)
                    message.actions[i] = $String(object.actions[i]);
            }
            return message;
        };

        /**
         * Creates a plain object from a Capability message. Also converts values to other types if specified.
         * @function toObject
         * @memberof physical.Capability
         * @static
         * @param {physical.Capability} message Capability
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Capability.toObject = function (message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw $Error("max depth exceeded");
            let object = {};
            if (options.arrays || options.defaults)
                object.actions = [];
            if (options.defaults)
                object.deviceId = "";
            if (message.deviceId != null && $Object.hasOwnProperty.call(message, "deviceId"))
                object.deviceId = message.deviceId;
            if (message.actions && message.actions.length) {
                object.actions = $Array(message.actions.length);
                for (let j = 0; j < message.actions.length; ++j)
                    object.actions[j] = message.actions[j];
            }
            return object;
        };

        /**
         * Converts this Capability to JSON.
         * @function toJSON
         * @memberof physical.Capability
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Capability.prototype.toJSON = function() {
            return Capability.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for Capability
         * @function getTypeUrl
         * @memberof physical.Capability
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        Capability.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/physical.Capability";
        };

        return Capability;
    })();

    return physical;
})();

export {
  $root as default
};
