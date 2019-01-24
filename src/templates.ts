import fs from 'fs';
import Mustache from 'mustache';
import path from 'path';
import { Globals } from './globals';

/**
 * Holds all templates, and know how to apply them
 */
export class Templates {

  private templates: { [key: string]: string } = {};
  private globals: { [key: string]: any } = {};

  constructor(builtInDir: string, customDir: string) {
    const builtInTemplates = fs.readdirSync(builtInDir);
    const customTemplates = customDir === '' ? [] : fs.readdirSync(customDir);
    // Read all built-in templates, but taking into account an override, if any
    for (const file of builtInTemplates) {
      const baseName = this.baseName(file);
      if (baseName) {
        const dir = customTemplates.includes(file) ? customDir : builtInDir;
        this.templates[baseName] = fs.readFileSync(path.join(dir, file), 'utf-8');
      }
    }
    // Also read any custom templates which are not built-in
    for (const file of customTemplates) {
      const baseName = this.baseName(file);
      if (baseName) {
        this.templates[baseName] = fs.readFileSync(path.join(customDir, file), 'utf-8');
      }
    }
  }

  /**
   * Sets a global variable, that is, added to the model of all templates
   */
  setGlobals(globals: Globals) {
    for (const name of Object.keys(globals)) {
      const value = (globals as { [key: string]: any })[name];
      this.globals[name] = value;
    }
  }

  private baseName(file: string): string | null {
    if (!file.endsWith('.mustache')) {
      return null;
    }
    return file.substring(0, file.length - '.mustache'.length);
  }

  /**
   * Applies a template with a given model
   * @param template The template name (file without .mustache extension)
   * @param model The model variables to be passed in to the template
   */
  apply(template: string, model: { [key: string]: any }): string {
    const actualTemplate = this.templates[template];
    if (!actualTemplate) {
      throw new Error(`Template not found: ${template}`);
    }
    const actualModel: { [key: string]: any } = { ...this.globals, ...model };
    return Mustache.render(actualTemplate, actualModel, this.templates);
  }

  /**
   * Applies a template with a given model, and then writes the content to a file
   * @param template The template name (file without .mustache extension)
   * @param model The model variables to be passed in to the template
   * @param file The absolute file name
   */
  write(template: string, model: { [key: string]: any }, file: string) {
    const content = this.apply(template, model);
    fs.writeFileSync(file, content, { encoding: 'utf-8' });
    console.info(`Wrote ${file}`);
  }

}