import { last, upperFirst } from 'lodash';
import { ContentObject, MediaTypeObject, OpenAPIObject, OperationObject, ParameterObject, PathItemObject, ReferenceObject, RequestBodyObject, ResponseObject, SecurityRequirementObject, SecuritySchemeObject } from 'openapi3-ts';
import { Content } from './content';
import { resolveRef, typeName } from './gen-utils';
import { OperationVariant } from './operation-variant';
import { Options } from './options';
import { Parameter } from './parameter';
import { RequestBody } from './request-body';
import { Response } from './response';
import { Security } from './security';
import { Logger } from './logger';

/**
 * An operation descriptor
 */
export class Operation {
  tags: string[];
  methodName: string;
  pathVar: string;
  parameters: Parameter[] = [];
  hasParameters: boolean;
  parametersRequired = false;
  security: Security[][] = [];
  deprecated: boolean;

  requestBody?: RequestBody;
  successResponse?: Response;
  allResponses: Response[] = [];
  pathExpression: string;
  variants: OperationVariant[] = [];
  logger: Logger;

  constructor(
    public openApi: OpenAPIObject,
    public path: string,
    public pathSpec: PathItemObject,
    public method: string,
    public id: string,
    public spec: OperationObject,
    public options: Options) {

    this.logger = new Logger(options.silent);
    this.path = this.path.replace(/\'/g, '\\\'');
    this.tags = spec.tags || [];
    this.pathVar = `${upperFirst(id)}Path`;
    this.methodName = spec['x-operation-name'] || this.id;

    // Add both the common and specific parameters
    this.parameters = [
      ...this.collectParameters(pathSpec.parameters),
      ...this.collectParameters(spec.parameters),
    ];
    if (this.parameters.find(p => p.required)) {
      this.parametersRequired = true;
    }
    this.hasParameters = this.parameters.length > 0;

    this.security = spec.security ? this.collectSecurity(spec.security) : this.collectSecurity(openApi.security);

    let body = spec.requestBody;
    if (body) {
      if (body.$ref) {
        body = resolveRef(this.openApi, body.$ref);
      }
      body = body as RequestBodyObject;
      this.requestBody = new RequestBody(body, this.collectContent(body.content), this.options);
      if (body.required) {
        this.parametersRequired = true;
      }
    }
    const responses = this.collectResponses();
    this.successResponse = responses.success;
    this.allResponses = responses.all;
    this.pathExpression = this.toPathExpression();

    this.deprecated = !!spec.deprecated;

    // Now calculate the variants: request body content x success response content
    this.calculateVariants();
  }

  private collectParameters(params: (ParameterObject | ReferenceObject)[] | undefined): Parameter[] {
    const result: Parameter[] = [];
    if (params) {
      for (let param of params) {

        if (param.$ref) {
          param = resolveRef(this.openApi, param.$ref);
        }
        param = param as ParameterObject;

        if (param.in === 'cookie') {
          this.logger.warn(`Ignoring cookie parameter ${this.id}.${param.name} as cookie parameters cannot be sent in XmlHttpRequests.`);
        } else if (this.paramIsNotExcluded(param)) {
          result.push(new Parameter(param as ParameterObject, this.options, this.openApi));
        }
      }

    }
    return result;
  }

  private collectSecurity(params: (SecurityRequirementObject)[] | undefined): Security[][] {
    if (!params) { return []; }

    return params.map((param) => {
      return Object.keys(param).map(key => {
        const scope = param[key];
        const security: SecuritySchemeObject = resolveRef(this.openApi, `#/components/securitySchemes/${key}`);
        return new Security(key, security, scope, this.options, this.openApi);
      });
    });
  }

  private paramIsNotExcluded(param: ParameterObject): boolean {
    const excludedParameters = this.options.excludeParameters || [];
    return !excludedParameters.includes(param.name);
  }

  private collectContent(desc: ContentObject | undefined): Content[] {
    const result: Content[] = [];
    if (desc) {
      for (const type of Object.keys(desc)) {
        result.push(new Content(type, desc[type] as MediaTypeObject, this.options, this.openApi));
      }
    }
    return result;
  }

  private collectResponses(): { success: Response | undefined, all: Response[] } {
    let successResponse: Response | undefined = undefined;
    const allResponses: Response[] = [];
    const responses = this.spec.responses || {};
    const responseByType = new Map<string, Response>();
    for (const statusCode of Object.keys(responses)) {
      const response = this.getResponse(responses[statusCode], statusCode);
      allResponses.push(response);
      const statusInt = Number.parseInt(statusCode.trim(), 10);
      if (statusInt >= 200 && statusInt < 300 && !responseByType.has('successResponse')) {
        responseByType.set('successResponse', response);
      } else if (statusCode === 'default') {
        responseByType.set('defaultResponse', response);
      }
    }
    successResponse = responseByType.get('successResponse') ?? responseByType.get('defaultResponse');

    return { success: successResponse, all: allResponses };
  }

  private getResponse(responseObject: ResponseObject, statusCode: string): Response {
    let responseDesc = undefined;
    if (responseObject.$ref) {
      responseDesc = resolveRef(this.openApi, responseObject.$ref);
    } else {
      responseDesc = responseObject as ResponseObject;
    }
    const response = new Response(
      statusCode,
      responseDesc.description || '',
      this.collectContent(responseDesc.content),
      this.options
    );

    return response;
  }

  /**
   * Returns a path expression to be evaluated, for example:
   * "/a/{var1}/b/{var2}/" returns "/a/${params.var1}/b/${params.var2}"
   */
  private toPathExpression() {
    return (this.path || '').replace(/\{([^}]+)}/g, (_, pName) => {
      const param = this.parameters.find(p => p.name === pName);
      const paramName = param ? param.var : pName;
      return '${params.' + paramName + '}';
    });
  }

  private contentsByMethodPart(hasContent?: { content?: Content[] }): Map<string, Content | null> {
    const map = new Map<string, Content | null>();
    if (hasContent) {
      const content = hasContent.content;
      if (content && content.length > 0) {
        for (const type of content) {
          if (type && type.mediaType) {
            map.set(this.variantMethodPart(type), type);
          }
        }
      }
    }
    if (map.size === 0) {
      map.set('', null);
    } else if (map.size === 1) {
      const content = [...map.values()][0];
      map.clear();
      map.set('', content);
    }
    return map;
  }

  private calculateVariants() {
    // It is possible to have multiple content types which end up in the same method.
    // For example: application/json, application/foo-bar+json, text/json ...
    const requestVariants = this.contentsByMethodPart(this.requestBody);
    const responseVariants = this.contentsByMethodPart(this.successResponse);
    requestVariants.forEach((requestContent, requestPart) => {
      responseVariants.forEach((responseContent, responsePart) => {
        const methodName = this.methodName + requestPart + responsePart;
        this.variants.push(new OperationVariant(this, methodName, requestContent, responseContent, this.options));
      });
    });
  }

  /**
   * Returns how the given content is represented on the method name
   */
  private variantMethodPart(content: Content | null): string {
    if (content) {
      let type = content.mediaType.replace(/\/\*/, '');
      if (type === '*' || type === 'application/octet-stream') {
        return '$Any';
      }
      type = last(type.split('/')) as string;
      const plus = type.lastIndexOf('+');
      if (plus >= 0) {
        type = type.substr(plus + 1);
      }
      return this.options.skipJsonSuffix && type === 'json' ? '' : `$${typeName(type)}`;
    } else {
      return '';
    }
  }

}
