import {
    type ArgumentsHost,
    Catch,
    type ExceptionFilter,
    ForbiddenException,
    HttpStatus,
    UnauthorizedException,
} from '@nestjs/common'
import type { Response } from 'express'
import { CallAborted, LlmFailure } from '../domain/failures.js'
import { errorBody } from './openai.js'

/**
 * Errors of the model routes in the OpenAI shape (`{ error: { message, type,
 * code } }`), so OpenAI SDKs read them. A caller that left gets nothing.
 * Validation and database errors keep the service contract body (ErrorFilter).
 */
@Catch(LlmFailure, CallAborted, UnauthorizedException, ForbiddenException)
export class LlmErrorFilter implements ExceptionFilter {
    catch(exception: LlmFailure | CallAborted | UnauthorizedException | ForbiddenException, host: ArgumentsHost) {
        const response = host.switchToHttp().getResponse<Response>()
        if (exception instanceof CallAborted) {
            if (!response.headersSent) response.status(499).end()
            return
        }
        if (exception instanceof LlmFailure) {
            if (exception.resetsAt)
                response.setHeader(
                    'retry-after',
                    String(Math.max(1, Math.ceil((exception.resetsAt.getTime() - Date.now()) / 1000))),
                )
            response.status(exception.status).json(errorBody(exception))
            return
        }
        const status = exception.getStatus()
        response.status(status).json({
            error: {
                message: exception.message,
                type: status === HttpStatus.UNAUTHORIZED ? 'invalid_api_key' : 'permission_denied',
                code: status === HttpStatus.UNAUTHORIZED ? 'invalid_api_key' : 'permission_denied',
                param: null,
            },
        })
    }
}
