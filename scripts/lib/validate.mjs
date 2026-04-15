import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { bashJsonSchema } from './schemas.mjs';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(bashJsonSchema);

export function validateBashJson(obj) {
  const valid = validate(obj);
  return { valid, errors: valid ? [] : validate.errors };
}
