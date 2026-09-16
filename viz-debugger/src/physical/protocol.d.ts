import * as $protobuf from "protobufjs";
import Long = require("long");

/** Namespace physical. */
export namespace physical {

    /**
     * Properties of a PhysicalCommandEnvelope.
     * @deprecated Use physical.PhysicalCommandEnvelope.$Properties instead.
     */
    interface IPhysicalCommandEnvelope extends physical.PhysicalCommandEnvelope.$Properties {
    }

    /** Represents a PhysicalCommandEnvelope. */
    class PhysicalCommandEnvelope {

        /**
         * Constructs a new PhysicalCommandEnvelope.
         * @param [properties] Properties to set
         */
        constructor(properties?: physical.PhysicalCommandEnvelope.$Properties);

        /** Unknown fields preserved while decoding when enabled */
        $unknowns?: Uint8Array[];

        /** PhysicalCommandEnvelope command. */
        command?: (physical.Command.$Properties|null);

        /** PhysicalCommandEnvelope cancelRequest. */
        cancelRequest?: (physical.CancelCommandRequest.$Properties|null);

        /** PhysicalCommandEnvelope acceptance. */
        acceptance?: (physical.CommandAcceptance.$Properties|null);

        /** PhysicalCommandEnvelope status. */
        status?: (physical.CommandStatus.$Properties|null);

        /** PhysicalCommandEnvelope result. */
        result?: (physical.CommandResult.$Properties|null);

        /** PhysicalCommandEnvelope cancelResponse. */
        cancelResponse?: (physical.CancelCommandResponse.$Properties|null);

        /** PhysicalCommandEnvelope capability. */
        capability?: (physical.Capability.$Properties|null);

        /** PhysicalCommandEnvelope body. */
        body?: ("command"|"cancelRequest"|"acceptance"|"status"|"result"|"cancelResponse"|"capability");

        /**
         * Creates a new PhysicalCommandEnvelope instance using the specified properties.
         * @param [properties] Properties to set
         * @returns PhysicalCommandEnvelope instance
         */
        static create(properties: physical.PhysicalCommandEnvelope.$Shape): physical.PhysicalCommandEnvelope & physical.PhysicalCommandEnvelope.$Shape;
        static create(properties?: physical.PhysicalCommandEnvelope.$Properties): physical.PhysicalCommandEnvelope;

        /**
         * Encodes the specified PhysicalCommandEnvelope message. Does not implicitly {@link physical.PhysicalCommandEnvelope.verify|verify} messages.
         * @param message PhysicalCommandEnvelope message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: physical.PhysicalCommandEnvelope.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified PhysicalCommandEnvelope message, length delimited. Does not implicitly {@link physical.PhysicalCommandEnvelope.verify|verify} messages.
         * @param message PhysicalCommandEnvelope message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: physical.PhysicalCommandEnvelope.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a PhysicalCommandEnvelope message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {physical.PhysicalCommandEnvelope & physical.PhysicalCommandEnvelope.$Shape} PhysicalCommandEnvelope
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): physical.PhysicalCommandEnvelope & physical.PhysicalCommandEnvelope.$Shape;

        /**
         * Decodes a PhysicalCommandEnvelope message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {physical.PhysicalCommandEnvelope & physical.PhysicalCommandEnvelope.$Shape} PhysicalCommandEnvelope
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): physical.PhysicalCommandEnvelope & physical.PhysicalCommandEnvelope.$Shape;

        /**
         * Verifies a PhysicalCommandEnvelope message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a PhysicalCommandEnvelope message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns PhysicalCommandEnvelope
         */
        static fromObject(object: { [k: string]: any }): physical.PhysicalCommandEnvelope;

        /**
         * Creates a plain object from a PhysicalCommandEnvelope message. Also converts values to other types if specified.
         * @param message PhysicalCommandEnvelope
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: physical.PhysicalCommandEnvelope, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this PhysicalCommandEnvelope to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for PhysicalCommandEnvelope
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace PhysicalCommandEnvelope {

        /** Properties of a PhysicalCommandEnvelope. */
        interface $Properties {

            /** PhysicalCommandEnvelope command */
            command?: (physical.Command.$Properties|null);

            /** PhysicalCommandEnvelope cancelRequest */
            cancelRequest?: (physical.CancelCommandRequest.$Properties|null);

            /** PhysicalCommandEnvelope acceptance */
            acceptance?: (physical.CommandAcceptance.$Properties|null);

            /** PhysicalCommandEnvelope status */
            status?: (physical.CommandStatus.$Properties|null);

            /** PhysicalCommandEnvelope result */
            result?: (physical.CommandResult.$Properties|null);

            /** PhysicalCommandEnvelope cancelResponse */
            cancelResponse?: (physical.CancelCommandResponse.$Properties|null);

            /** PhysicalCommandEnvelope capability */
            capability?: (physical.Capability.$Properties|null);

            /** PhysicalCommandEnvelope body */
            body?: ("command"|"cancelRequest"|"acceptance"|"status"|"result"|"cancelResponse"|"capability");

            /** Unknown fields preserved while decoding when enabled */
            $unknowns?: Uint8Array[];
        }

        /** Narrowed shape of a PhysicalCommandEnvelope. */
        type $Shape = {
          command?: physical.Command.$Shape|null;
          cancelRequest?: physical.CancelCommandRequest.$Shape|null;
          acceptance?: physical.CommandAcceptance.$Shape|null;
          status?: physical.CommandStatus.$Shape|null;
          result?: physical.CommandResult.$Shape|null;
          cancelResponse?: physical.CancelCommandResponse.$Shape|null;
          capability?: physical.Capability.$Shape|null;
          $unknowns?: Uint8Array[];
        } & (
          ({ body?: undefined; command?: null; cancelRequest?: null; acceptance?: null; status?: null; result?: null; cancelResponse?: null; capability?: null }|{ body?: "command"; command: physical.Command.$Shape; cancelRequest?: null; acceptance?: null; status?: null; result?: null; cancelResponse?: null; capability?: null }|{ body?: "cancelRequest"; command?: null; cancelRequest: physical.CancelCommandRequest.$Shape; acceptance?: null; status?: null; result?: null; cancelResponse?: null; capability?: null }|{ body?: "acceptance"; command?: null; cancelRequest?: null; acceptance: physical.CommandAcceptance.$Shape; status?: null; result?: null; cancelResponse?: null; capability?: null }|{ body?: "status"; command?: null; cancelRequest?: null; acceptance?: null; status: physical.CommandStatus.$Shape; result?: null; cancelResponse?: null; capability?: null }|{ body?: "result"; command?: null; cancelRequest?: null; acceptance?: null; status?: null; result: physical.CommandResult.$Shape; cancelResponse?: null; capability?: null }|{ body?: "cancelResponse"; command?: null; cancelRequest?: null; acceptance?: null; status?: null; result?: null; cancelResponse: physical.CancelCommandResponse.$Shape; capability?: null }|{ body?: "capability"; command?: null; cancelRequest?: null; acceptance?: null; status?: null; result?: null; cancelResponse?: null; capability: physical.Capability.$Shape })
        );
    }

    /** TerminalStatus enum. */
    enum TerminalStatus {

        /** TERMINAL_STATUS_UNSPECIFIED value */
        TERMINAL_STATUS_UNSPECIFIED = 0,

        /** SUCCEEDED value */
        SUCCEEDED = 1,

        /** ABORTED value */
        ABORTED = 2,

        /** CANCELED value */
        CANCELED = 3
    }

    /**
     * Properties of a Command.
     * @deprecated Use physical.Command.$Properties instead.
     */
    interface ICommand extends physical.Command.$Properties {
    }

    /** Represents a Command. */
    class Command {

        /**
         * Constructs a new Command.
         * @param [properties] Properties to set
         */
        constructor(properties?: physical.Command.$Properties);

        /** Unknown fields preserved while decoding when enabled */
        $unknowns?: Uint8Array[];

        /** Command commandId. */
        commandId: string;

        /** Command target. */
        target: string;

        /** Command action. */
        action: string;

        /** Command parameters. */
        parameters: { [k: string]: number };

        /** Command deadlineUnixMs. */
        deadlineUnixMs: (number|Long);

        /**
         * Creates a new Command instance using the specified properties.
         * @param [properties] Properties to set
         * @returns Command instance
         */
        static create(properties: physical.Command.$Shape): physical.Command & physical.Command.$Shape;
        static create(properties?: physical.Command.$Properties): physical.Command;

        /**
         * Encodes the specified Command message. Does not implicitly {@link physical.Command.verify|verify} messages.
         * @param message Command message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: physical.Command.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified Command message, length delimited. Does not implicitly {@link physical.Command.verify|verify} messages.
         * @param message Command message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: physical.Command.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a Command message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {physical.Command & physical.Command.$Shape} Command
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): physical.Command & physical.Command.$Shape;

        /**
         * Decodes a Command message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {physical.Command & physical.Command.$Shape} Command
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): physical.Command & physical.Command.$Shape;

        /**
         * Verifies a Command message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a Command message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns Command
         */
        static fromObject(object: { [k: string]: any }): physical.Command;

        /**
         * Creates a plain object from a Command message. Also converts values to other types if specified.
         * @param message Command
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: physical.Command, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this Command to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for Command
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace Command {

        /** Properties of a Command. */
        interface $Properties {

            /** Command commandId */
            commandId?: (string|null);

            /** Command target */
            target?: (string|null);

            /** Command action */
            action?: (string|null);

            /** Command parameters */
            parameters?: ({ [k: string]: number }|null);

            /** Command deadlineUnixMs */
            deadlineUnixMs?: (number|Long|null);

            /** Unknown fields preserved while decoding when enabled */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a Command. */
        type $Shape = physical.Command.$Properties;
    }

    /**
     * Properties of a CancelCommandRequest.
     * @deprecated Use physical.CancelCommandRequest.$Properties instead.
     */
    interface ICancelCommandRequest extends physical.CancelCommandRequest.$Properties {
    }

    /** Represents a CancelCommandRequest. */
    class CancelCommandRequest {

        /**
         * Constructs a new CancelCommandRequest.
         * @param [properties] Properties to set
         */
        constructor(properties?: physical.CancelCommandRequest.$Properties);

        /** Unknown fields preserved while decoding when enabled */
        $unknowns?: Uint8Array[];

        /** CancelCommandRequest commandId. */
        commandId: string;

        /**
         * Creates a new CancelCommandRequest instance using the specified properties.
         * @param [properties] Properties to set
         * @returns CancelCommandRequest instance
         */
        static create(properties: physical.CancelCommandRequest.$Shape): physical.CancelCommandRequest & physical.CancelCommandRequest.$Shape;
        static create(properties?: physical.CancelCommandRequest.$Properties): physical.CancelCommandRequest;

        /**
         * Encodes the specified CancelCommandRequest message. Does not implicitly {@link physical.CancelCommandRequest.verify|verify} messages.
         * @param message CancelCommandRequest message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: physical.CancelCommandRequest.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified CancelCommandRequest message, length delimited. Does not implicitly {@link physical.CancelCommandRequest.verify|verify} messages.
         * @param message CancelCommandRequest message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: physical.CancelCommandRequest.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a CancelCommandRequest message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {physical.CancelCommandRequest & physical.CancelCommandRequest.$Shape} CancelCommandRequest
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): physical.CancelCommandRequest & physical.CancelCommandRequest.$Shape;

        /**
         * Decodes a CancelCommandRequest message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {physical.CancelCommandRequest & physical.CancelCommandRequest.$Shape} CancelCommandRequest
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): physical.CancelCommandRequest & physical.CancelCommandRequest.$Shape;

        /**
         * Verifies a CancelCommandRequest message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a CancelCommandRequest message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns CancelCommandRequest
         */
        static fromObject(object: { [k: string]: any }): physical.CancelCommandRequest;

        /**
         * Creates a plain object from a CancelCommandRequest message. Also converts values to other types if specified.
         * @param message CancelCommandRequest
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: physical.CancelCommandRequest, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this CancelCommandRequest to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for CancelCommandRequest
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace CancelCommandRequest {

        /** Properties of a CancelCommandRequest. */
        interface $Properties {

            /** CancelCommandRequest commandId */
            commandId?: (string|null);

            /** Unknown fields preserved while decoding when enabled */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a CancelCommandRequest. */
        type $Shape = physical.CancelCommandRequest.$Properties;
    }

    /**
     * Properties of a Rejection.
     * @deprecated Use physical.Rejection.$Properties instead.
     */
    interface IRejection extends physical.Rejection.$Properties {
    }

    /** Represents a Rejection. */
    class Rejection {

        /**
         * Constructs a new Rejection.
         * @param [properties] Properties to set
         */
        constructor(properties?: physical.Rejection.$Properties);

        /** Unknown fields preserved while decoding when enabled */
        $unknowns?: Uint8Array[];

        /** Rejection code. */
        code: string;

        /** Rejection message. */
        message: string;

        /**
         * Creates a new Rejection instance using the specified properties.
         * @param [properties] Properties to set
         * @returns Rejection instance
         */
        static create(properties: physical.Rejection.$Shape): physical.Rejection & physical.Rejection.$Shape;
        static create(properties?: physical.Rejection.$Properties): physical.Rejection;

        /**
         * Encodes the specified Rejection message. Does not implicitly {@link physical.Rejection.verify|verify} messages.
         * @param message Rejection message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: physical.Rejection.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified Rejection message, length delimited. Does not implicitly {@link physical.Rejection.verify|verify} messages.
         * @param message Rejection message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: physical.Rejection.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a Rejection message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {physical.Rejection & physical.Rejection.$Shape} Rejection
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): physical.Rejection & physical.Rejection.$Shape;

        /**
         * Decodes a Rejection message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {physical.Rejection & physical.Rejection.$Shape} Rejection
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): physical.Rejection & physical.Rejection.$Shape;

        /**
         * Verifies a Rejection message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a Rejection message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns Rejection
         */
        static fromObject(object: { [k: string]: any }): physical.Rejection;

        /**
         * Creates a plain object from a Rejection message. Also converts values to other types if specified.
         * @param message Rejection
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: physical.Rejection, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this Rejection to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for Rejection
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace Rejection {

        /** Properties of a Rejection. */
        interface $Properties {

            /** Rejection code */
            code?: (string|null);

            /** Rejection message */
            message?: (string|null);

            /** Unknown fields preserved while decoding when enabled */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a Rejection. */
        type $Shape = physical.Rejection.$Properties;
    }

    /**
     * Properties of a Failure.
     * @deprecated Use physical.Failure.$Properties instead.
     */
    interface IFailure extends physical.Failure.$Properties {
    }

    /** Represents a Failure. */
    class Failure {

        /**
         * Constructs a new Failure.
         * @param [properties] Properties to set
         */
        constructor(properties?: physical.Failure.$Properties);

        /** Unknown fields preserved while decoding when enabled */
        $unknowns?: Uint8Array[];

        /** Failure code. */
        code: string;

        /** Failure message. */
        message: string;

        /**
         * Creates a new Failure instance using the specified properties.
         * @param [properties] Properties to set
         * @returns Failure instance
         */
        static create(properties: physical.Failure.$Shape): physical.Failure & physical.Failure.$Shape;
        static create(properties?: physical.Failure.$Properties): physical.Failure;

        /**
         * Encodes the specified Failure message. Does not implicitly {@link physical.Failure.verify|verify} messages.
         * @param message Failure message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: physical.Failure.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified Failure message, length delimited. Does not implicitly {@link physical.Failure.verify|verify} messages.
         * @param message Failure message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: physical.Failure.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a Failure message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {physical.Failure & physical.Failure.$Shape} Failure
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): physical.Failure & physical.Failure.$Shape;

        /**
         * Decodes a Failure message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {physical.Failure & physical.Failure.$Shape} Failure
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): physical.Failure & physical.Failure.$Shape;

        /**
         * Verifies a Failure message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a Failure message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns Failure
         */
        static fromObject(object: { [k: string]: any }): physical.Failure;

        /**
         * Creates a plain object from a Failure message. Also converts values to other types if specified.
         * @param message Failure
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: physical.Failure, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this Failure to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for Failure
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace Failure {

        /** Properties of a Failure. */
        interface $Properties {

            /** Failure code */
            code?: (string|null);

            /** Failure message */
            message?: (string|null);

            /** Unknown fields preserved while decoding when enabled */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a Failure. */
        type $Shape = physical.Failure.$Properties;
    }

    /**
     * Properties of a CommandAcceptance.
     * @deprecated Use physical.CommandAcceptance.$Properties instead.
     */
    interface ICommandAcceptance extends physical.CommandAcceptance.$Properties {
    }

    /** Represents a CommandAcceptance. */
    class CommandAcceptance {

        /**
         * Constructs a new CommandAcceptance.
         * @param [properties] Properties to set
         */
        constructor(properties?: physical.CommandAcceptance.$Properties);

        /** Unknown fields preserved while decoding when enabled */
        $unknowns?: Uint8Array[];

        /** CommandAcceptance commandId. */
        commandId: string;

        /** CommandAcceptance accepted. */
        accepted: boolean;

        /** CommandAcceptance rejection. */
        rejection?: (physical.Rejection.$Properties|null);

        /**
         * Creates a new CommandAcceptance instance using the specified properties.
         * @param [properties] Properties to set
         * @returns CommandAcceptance instance
         */
        static create(properties: physical.CommandAcceptance.$Shape): physical.CommandAcceptance & physical.CommandAcceptance.$Shape;
        static create(properties?: physical.CommandAcceptance.$Properties): physical.CommandAcceptance;

        /**
         * Encodes the specified CommandAcceptance message. Does not implicitly {@link physical.CommandAcceptance.verify|verify} messages.
         * @param message CommandAcceptance message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: physical.CommandAcceptance.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified CommandAcceptance message, length delimited. Does not implicitly {@link physical.CommandAcceptance.verify|verify} messages.
         * @param message CommandAcceptance message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: physical.CommandAcceptance.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a CommandAcceptance message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {physical.CommandAcceptance & physical.CommandAcceptance.$Shape} CommandAcceptance
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): physical.CommandAcceptance & physical.CommandAcceptance.$Shape;

        /**
         * Decodes a CommandAcceptance message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {physical.CommandAcceptance & physical.CommandAcceptance.$Shape} CommandAcceptance
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): physical.CommandAcceptance & physical.CommandAcceptance.$Shape;

        /**
         * Verifies a CommandAcceptance message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a CommandAcceptance message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns CommandAcceptance
         */
        static fromObject(object: { [k: string]: any }): physical.CommandAcceptance;

        /**
         * Creates a plain object from a CommandAcceptance message. Also converts values to other types if specified.
         * @param message CommandAcceptance
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: physical.CommandAcceptance, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this CommandAcceptance to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for CommandAcceptance
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace CommandAcceptance {

        /** Properties of a CommandAcceptance. */
        interface $Properties {

            /** CommandAcceptance commandId */
            commandId?: (string|null);

            /** CommandAcceptance accepted */
            accepted?: (boolean|null);

            /** CommandAcceptance rejection */
            rejection?: (physical.Rejection.$Properties|null);

            /** Unknown fields preserved while decoding when enabled */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a CommandAcceptance. */
        type $Shape = physical.CommandAcceptance.$Properties;
    }

    /**
     * Properties of a CommandStatus.
     * @deprecated Use physical.CommandStatus.$Properties instead.
     */
    interface ICommandStatus extends physical.CommandStatus.$Properties {
    }

    /** Represents a CommandStatus. */
    class CommandStatus {

        /**
         * Constructs a new CommandStatus.
         * @param [properties] Properties to set
         */
        constructor(properties?: physical.CommandStatus.$Properties);

        /** Unknown fields preserved while decoding when enabled */
        $unknowns?: Uint8Array[];

        /** CommandStatus commandId. */
        commandId: string;

        /** CommandStatus state. */
        state: string;

        /** CommandStatus detail. */
        detail: string;

        /**
         * Creates a new CommandStatus instance using the specified properties.
         * @param [properties] Properties to set
         * @returns CommandStatus instance
         */
        static create(properties: physical.CommandStatus.$Shape): physical.CommandStatus & physical.CommandStatus.$Shape;
        static create(properties?: physical.CommandStatus.$Properties): physical.CommandStatus;

        /**
         * Encodes the specified CommandStatus message. Does not implicitly {@link physical.CommandStatus.verify|verify} messages.
         * @param message CommandStatus message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: physical.CommandStatus.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified CommandStatus message, length delimited. Does not implicitly {@link physical.CommandStatus.verify|verify} messages.
         * @param message CommandStatus message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: physical.CommandStatus.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a CommandStatus message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {physical.CommandStatus & physical.CommandStatus.$Shape} CommandStatus
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): physical.CommandStatus & physical.CommandStatus.$Shape;

        /**
         * Decodes a CommandStatus message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {physical.CommandStatus & physical.CommandStatus.$Shape} CommandStatus
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): physical.CommandStatus & physical.CommandStatus.$Shape;

        /**
         * Verifies a CommandStatus message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a CommandStatus message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns CommandStatus
         */
        static fromObject(object: { [k: string]: any }): physical.CommandStatus;

        /**
         * Creates a plain object from a CommandStatus message. Also converts values to other types if specified.
         * @param message CommandStatus
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: physical.CommandStatus, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this CommandStatus to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for CommandStatus
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace CommandStatus {

        /** Properties of a CommandStatus. */
        interface $Properties {

            /** CommandStatus commandId */
            commandId?: (string|null);

            /** CommandStatus state */
            state?: (string|null);

            /** CommandStatus detail */
            detail?: (string|null);

            /** Unknown fields preserved while decoding when enabled */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a CommandStatus. */
        type $Shape = physical.CommandStatus.$Properties;
    }

    /**
     * Properties of a CommandResult.
     * @deprecated Use physical.CommandResult.$Properties instead.
     */
    interface ICommandResult extends physical.CommandResult.$Properties {
    }

    /** Represents a CommandResult. */
    class CommandResult {

        /**
         * Constructs a new CommandResult.
         * @param [properties] Properties to set
         */
        constructor(properties?: physical.CommandResult.$Properties);

        /** Unknown fields preserved while decoding when enabled */
        $unknowns?: Uint8Array[];

        /** CommandResult commandId. */
        commandId: string;

        /** CommandResult status. */
        status: physical.TerminalStatus;

        /** CommandResult result. */
        result: { [k: string]: number };

        /** CommandResult failure. */
        failure?: (physical.Failure.$Properties|null);

        /**
         * Creates a new CommandResult instance using the specified properties.
         * @param [properties] Properties to set
         * @returns CommandResult instance
         */
        static create(properties: physical.CommandResult.$Shape): physical.CommandResult & physical.CommandResult.$Shape;
        static create(properties?: physical.CommandResult.$Properties): physical.CommandResult;

        /**
         * Encodes the specified CommandResult message. Does not implicitly {@link physical.CommandResult.verify|verify} messages.
         * @param message CommandResult message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: physical.CommandResult.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified CommandResult message, length delimited. Does not implicitly {@link physical.CommandResult.verify|verify} messages.
         * @param message CommandResult message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: physical.CommandResult.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a CommandResult message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {physical.CommandResult & physical.CommandResult.$Shape} CommandResult
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): physical.CommandResult & physical.CommandResult.$Shape;

        /**
         * Decodes a CommandResult message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {physical.CommandResult & physical.CommandResult.$Shape} CommandResult
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): physical.CommandResult & physical.CommandResult.$Shape;

        /**
         * Verifies a CommandResult message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a CommandResult message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns CommandResult
         */
        static fromObject(object: { [k: string]: any }): physical.CommandResult;

        /**
         * Creates a plain object from a CommandResult message. Also converts values to other types if specified.
         * @param message CommandResult
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: physical.CommandResult, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this CommandResult to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for CommandResult
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace CommandResult {

        /** Properties of a CommandResult. */
        interface $Properties {

            /** CommandResult commandId */
            commandId?: (string|null);

            /** CommandResult status */
            status?: (physical.TerminalStatus|null);

            /** CommandResult result */
            result?: ({ [k: string]: number }|null);

            /** CommandResult failure */
            failure?: (physical.Failure.$Properties|null);

            /** Unknown fields preserved while decoding when enabled */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a CommandResult. */
        type $Shape = physical.CommandResult.$Properties;
    }

    /**
     * Properties of a CancelCommandResponse.
     * @deprecated Use physical.CancelCommandResponse.$Properties instead.
     */
    interface ICancelCommandResponse extends physical.CancelCommandResponse.$Properties {
    }

    /** Represents a CancelCommandResponse. */
    class CancelCommandResponse {

        /**
         * Constructs a new CancelCommandResponse.
         * @param [properties] Properties to set
         */
        constructor(properties?: physical.CancelCommandResponse.$Properties);

        /** Unknown fields preserved while decoding when enabled */
        $unknowns?: Uint8Array[];

        /** CancelCommandResponse commandId. */
        commandId: string;

        /** CancelCommandResponse accepted. */
        accepted: boolean;

        /**
         * Creates a new CancelCommandResponse instance using the specified properties.
         * @param [properties] Properties to set
         * @returns CancelCommandResponse instance
         */
        static create(properties: physical.CancelCommandResponse.$Shape): physical.CancelCommandResponse & physical.CancelCommandResponse.$Shape;
        static create(properties?: physical.CancelCommandResponse.$Properties): physical.CancelCommandResponse;

        /**
         * Encodes the specified CancelCommandResponse message. Does not implicitly {@link physical.CancelCommandResponse.verify|verify} messages.
         * @param message CancelCommandResponse message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: physical.CancelCommandResponse.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified CancelCommandResponse message, length delimited. Does not implicitly {@link physical.CancelCommandResponse.verify|verify} messages.
         * @param message CancelCommandResponse message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: physical.CancelCommandResponse.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a CancelCommandResponse message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {physical.CancelCommandResponse & physical.CancelCommandResponse.$Shape} CancelCommandResponse
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): physical.CancelCommandResponse & physical.CancelCommandResponse.$Shape;

        /**
         * Decodes a CancelCommandResponse message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {physical.CancelCommandResponse & physical.CancelCommandResponse.$Shape} CancelCommandResponse
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): physical.CancelCommandResponse & physical.CancelCommandResponse.$Shape;

        /**
         * Verifies a CancelCommandResponse message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a CancelCommandResponse message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns CancelCommandResponse
         */
        static fromObject(object: { [k: string]: any }): physical.CancelCommandResponse;

        /**
         * Creates a plain object from a CancelCommandResponse message. Also converts values to other types if specified.
         * @param message CancelCommandResponse
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: physical.CancelCommandResponse, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this CancelCommandResponse to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for CancelCommandResponse
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace CancelCommandResponse {

        /** Properties of a CancelCommandResponse. */
        interface $Properties {

            /** CancelCommandResponse commandId */
            commandId?: (string|null);

            /** CancelCommandResponse accepted */
            accepted?: (boolean|null);

            /** Unknown fields preserved while decoding when enabled */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a CancelCommandResponse. */
        type $Shape = physical.CancelCommandResponse.$Properties;
    }

    /**
     * Properties of a Capability.
     * @deprecated Use physical.Capability.$Properties instead.
     */
    interface ICapability extends physical.Capability.$Properties {
    }

    /** Represents a Capability. */
    class Capability {

        /**
         * Constructs a new Capability.
         * @param [properties] Properties to set
         */
        constructor(properties?: physical.Capability.$Properties);

        /** Unknown fields preserved while decoding when enabled */
        $unknowns?: Uint8Array[];

        /** Capability deviceId. */
        deviceId: string;

        /** Capability actions. */
        actions: string[];

        /**
         * Creates a new Capability instance using the specified properties.
         * @param [properties] Properties to set
         * @returns Capability instance
         */
        static create(properties: physical.Capability.$Shape): physical.Capability & physical.Capability.$Shape;
        static create(properties?: physical.Capability.$Properties): physical.Capability;

        /**
         * Encodes the specified Capability message. Does not implicitly {@link physical.Capability.verify|verify} messages.
         * @param message Capability message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encode(message: physical.Capability.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified Capability message, length delimited. Does not implicitly {@link physical.Capability.verify|verify} messages.
         * @param message Capability message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        static encodeDelimited(message: physical.Capability.$Properties, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a Capability message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns {physical.Capability & physical.Capability.$Shape} Capability
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): physical.Capability & physical.Capability.$Shape;

        /**
         * Decodes a Capability message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns {physical.Capability & physical.Capability.$Shape} Capability
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): physical.Capability & physical.Capability.$Shape;

        /**
         * Verifies a Capability message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a Capability message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns Capability
         */
        static fromObject(object: { [k: string]: any }): physical.Capability;

        /**
         * Creates a plain object from a Capability message. Also converts values to other types if specified.
         * @param message Capability
         * @param [options] Conversion options
         * @returns Plain object
         */
        static toObject(message: physical.Capability, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this Capability to JSON.
         * @returns JSON object
         */
        toJSON(): { [k: string]: any };

        /**
         * Gets the type url for Capability
         * @param [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns The type url
         */
        static getTypeUrl(prefix?: string): string;
    }

    namespace Capability {

        /** Properties of a Capability. */
        interface $Properties {

            /** Capability deviceId */
            deviceId?: (string|null);

            /** Capability actions */
            actions?: (string[]|null);

            /** Unknown fields preserved while decoding when enabled */
            $unknowns?: Uint8Array[];
        }

        /** Shape of a Capability. */
        type $Shape = physical.Capability.$Properties;
    }
}
