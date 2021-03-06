const fs = require('fs');
const { SiteClient } = require('datocms-client');

const envVariables = fs.readFileSync('.env.local', 'utf-8');
const tokenString = envVariables.match(/DATOCMS_READWRITE_TOKEN="(.*?)"/g);
const token = tokenString[0].substring(
  tokenString[0].indexOf('"') + 1,
  tokenString[0].lastIndexOf('"')
);
const sandboxEnv = 'development';
const productionEnv = 'migration-test';
const developmentClient = new SiteClient(token, {
  environment: sandboxEnv,
});
const productionClient = new SiteClient(token, {
  environment: productionEnv,
});

const generateValidShapeNewModelOrBlock = (model) => {
  const {
    id,
    fields,
    titleField,
    hasSingletonItem,
    collectionAppeareance,
    singletonItem,
    ...validShapeNewModel
  } = model;
  return validShapeNewModel;
};

const generateValidShapeField = async (
  field,
  devModelsAndBlocks,
  prodModelsAndBlocks,
  prodModelFieldsets,
  prodPlugins
) => {
  const { id, appeareance, itemType, ...validShapeField } = field;
  if (validShapeField.fieldset) {
    const devFieldset = await developmentClient.fieldsets.find(
      validShapeField.fieldset
    );
    for (let prodFieldset of prodModelFieldsets) {
      if (prodFieldset.title === devFieldset.title) {
        validShapeField.fieldset = prodFieldset.id;
        break;
      }
    }
  }
  if (validShapeField.appearance.addons.length > 0) {
    for (let addon of validShapeField.appearance.addons) {
      try {
        const devPlugin = await developmentClient.plugins.find(addon.id);
        const prodPlugin = prodPlugins.find(
          (prodPlugin) => prodPlugin.packageName === devPlugin.packageName
        );
        if (prodPlugin.id) {
          addon.id = prodPlugin.id;
        }
      } catch (e) {
        console.warn('developmentClient.plugins.find section error', e);
      }
    }
  }
  await changeFieldValidators(
    validShapeField.validators,
    devModelsAndBlocks,
    prodModelsAndBlocks,
    itemType
  );
  return validShapeField;
};

const changeFieldValidators = async (
  validators,
  devModelsAndBlocks,
  prodModelsAndBlocks,
  itemType
) => {
  const validatorsKeys = Object.keys(validators);
  for (let i = 0; i < validatorsKeys.length; i++) {
    const validatorItemTypes = validators[validatorsKeys[i]]?.itemTypes;
    if (validatorItemTypes?.length > 0) {
      const correctItemTypes = [];
      for (let i = 0; i < validatorItemTypes.length; i++) {
        const devModel = devModelsAndBlocks.find(
          (modelOrBlock) => modelOrBlock.id === validatorItemTypes[i]
        );
        let correctItem = prodModelsAndBlocks.find(
          (modelOrBlock) => modelOrBlock.apiKey === devModel.apiKey
        );
        if (!correctItem) {
          const { id } = await productionClient.itemTypes.find(devModel.apiKey);
          correctItemTypes.push(id);
        } else correctItemTypes.push(correctItem.id);
      }
      validators[validatorsKeys[i]].itemTypes = correctItemTypes;
    }
    if (validators[validatorsKeys[i]]?.titleFieldId) {
      const { apiKey } = await developmentClient.fields.find(
        validators[validatorsKeys[i]].titleFieldId
      );
      const { apiKey: devBlockOrModelApiKey } = devModelsAndBlocks.find(
        (devBlockOrModel) => devBlockOrModel.id === itemType
      );
      const { id: prodBlockOrModelId } = prodModelsAndBlocks.find(
        (prodBlockOrModel) => prodBlockOrModel.apiKey === devBlockOrModelApiKey
      );
      const allFields = await productionClient.fields.all(prodBlockOrModelId);
      let correctItem = allFields.find((field) => field.apiKey === apiKey);
      validators[validatorsKeys[i]].titleFieldId = correctItem.id;
    }
  }
};

const sortModels = (modelA, modelB) => {
  return modelA.modularBlock === modelB.modularBlock
    ? 0
    : modelA.modularBlock
    ? -1
    : 1;
};

const sortFieldsByPosition = (a, b) => a.position - b.position;

const migrateBlocksAndModels = async (
  modelsAndBlocksToCreate,
  modelsAndBlocksToUpdate,
  modelsAndBlocksToDelete
) => {
  try {
    for (let i = 0; i < modelsAndBlocksToCreate.length; i++) {
      await productionClient.itemTypes.create(
        generateValidShapeNewModelOrBlock(modelsAndBlocksToCreate[i])
      );
      console.log(`model ${modelsAndBlocksToCreate[i].apiKey} created`);
    }
    for (let i = 0; i < modelsAndBlocksToUpdate.length; i++) {
      await productionClient.itemTypes.update(
        modelsAndBlocksToUpdate[i].apiKey,
        generateValidShapeNewModelOrBlock(modelsAndBlocksToUpdate[i])
      );
      console.log(`model ${modelsAndBlocksToUpdate[i].apiKey} updated`);
    }
    for (let i = 0; i < modelsAndBlocksToDelete.length; i++) {
      await productionClient.itemTypes.destroy(
        modelsAndBlocksToDelete[i].apiKey
      );
      console.log(`model ${modelsAndBlocksToDelete[i].apiKey} deleted`);
    }
    console.log('blocks and models have been migrated');
  } catch (e) {
    console.warn('migrateBlocksAndModels error', e);
  }
};

const migrateFields = async (devModelsAndBlocks) => {
  try {
    const prodModelsAndBlocks = await productionClient.itemTypes.all();
    prodModelsAndBlocks.sort(sortModels);
    for (let i = 0; i < devModelsAndBlocks.length; i++) {
      const modelApiKey = devModelsAndBlocks[i].apiKey;
      const devFields = await developmentClient.fields.all(modelApiKey);
      const prodFields = await productionClient.fields.all(modelApiKey);
      const prodModelFieldsets = await productionClient.fieldsets.all(
        modelApiKey
      );
      const prodPlugins = await productionClient.plugins.all();
      const fieldsToCreate = [];
      const fieldsToUpdate = [];
      const fieldsToDelete = [];
      devFields.forEach((devField) => {
        const existingProdField = prodFields.find(
          (prodField) => prodField.apiKey === devField.apiKey
        );
        if (existingProdField) {
          fieldsToUpdate.push({
            ...devField,
            id: existingProdField.id,
          });
        } else {
          fieldsToCreate.push(devField);
        }
      });
      prodFields.forEach((prodField) => {
        if (
          !devFields.some((devField) => devField.apiKey === prodField.apiKey)
        ) {
          fieldsToDelete.push(prodField);
        }
      });
      fieldsToCreate.sort(sortFieldsByPosition);
      fieldsToUpdate.sort(sortFieldsByPosition);
      for (let i = 0; i < fieldsToCreate.length; i++) {
        const newField = await generateValidShapeField(
          fieldsToCreate[i],
          devModelsAndBlocks,
          prodModelsAndBlocks,
          prodModelFieldsets,
          prodPlugins
        );
        await productionClient.fields.create(modelApiKey, newField);
        console.log(
          `field ${newField.apiKey} of ${modelApiKey} model is created`
        );
      }
      for (let i = 0; i < fieldsToUpdate.length; i++) {
        const newField = await generateValidShapeField(
          fieldsToUpdate[i],
          devModelsAndBlocks,
          prodModelsAndBlocks,
          prodModelFieldsets,
          prodPlugins
        );
        await productionClient.fields.update(fieldsToUpdate[i].id, newField);
        console.log(
          `field ${newField.apiKey} of ${modelApiKey} model is updated`
        );
      }
      for (let i = 0; i < fieldsToDelete.length; i++) {
        await productionClient.fields.destroy(fieldsToDelete[i].id);
        console.log(
          `field ${fieldsToDelete[i].apiKey} of ${modelApiKey} model is deleted`
        );
      }
    }
    console.log('fields migration is finished');
  } catch (e) {
    console.warn('migrateFields error', e);
  }
};

const migrateFieldsets = async (devModelsAndBlocks) => {
  try {
    for (let devModel of devModelsAndBlocks) {
      const modelApiKey = devModel.apiKey;
      const devFieldsets = await developmentClient.fieldsets.all(modelApiKey);
      const prodFieldsets = await productionClient.fieldsets.all(modelApiKey);
      const fieldsetsToCreate = [];
      const fieldsetsToUpdate = [];
      const fieldsetsToDelete = [];
      devFieldsets.forEach((devFieldset) => {
        const existingProdField = prodFieldsets.find(
          (prodFieldset) => prodFieldset.title === devFieldset.title
        );
        const { id, itemType, ...validFieldset } = devFieldset;
        if (existingProdField) {
          fieldsetsToUpdate.push({
            id: existingProdField.id,
            ...validFieldset,
          });
        } else {
          fieldsetsToCreate.push(validFieldset);
        }
      });
      prodFieldsets.forEach((prodFieldset) => {
        if (
          !devFieldsets.some(
            (devFieldset) => devFieldset.title === prodFieldset.title
          )
        ) {
          fieldsetsToDelete.push(prodFieldset.id);
        }
      });
      for (let fieldsetToCreate of fieldsetsToCreate) {
        await productionClient.fieldsets.create(modelApiKey, fieldsetToCreate);
        console.log(
          `fieldset ${fieldsetToCreate.title} of ${modelApiKey} model is created`
        );
      }
      for (let fieldsetToUpdate of fieldsetsToUpdate) {
        const { id, ...validFieldset } = fieldsetToUpdate;
        await productionClient.fieldsets.update(id, validFieldset);
        console.log(
          `fieldset ${fieldsetToUpdate.title} of ${modelApiKey} model is updated`
        );
      }
      for (let fieldsetToDeleteId of fieldsetsToDelete) {
        await productionClient.fieldsets.destroy(fieldsetToDeleteId);
        console.log(
          `fieldset ${fieldsetToDeleteId} of ${modelApiKey} model is deleted`
        );
      }
    }
    console.log('fieldsets migration is finished');
  } catch (e) {
    console.warn('migrateFieldsets error', e);
  }
};

const migratePlugins = async () => {
  try {
    const devPlugins = await developmentClient.plugins.all();
    const prodPlugins = await productionClient.plugins.all();
    for (let devPlugin of devPlugins) {
      if (
        !prodPlugins.some(
          (prodPlugin) => prodPlugin.packageName === devPlugin.packageName
        )
      ) {
        const { id, ...validNewPlugin } = devPlugin;
        await productionClient.plugins.create(validNewPlugin);
        console.log(`plugin ${validNewPlugin.packageName} is created`);
      }
    }
    for (let prodPlugin of prodPlugins) {
      if (
        !devPlugins.some(
          (devPlugin) => devPlugin.packageName === prodPlugin.packageName
        )
      ) {
        await productionClient.plugins.destroy(prodPlugin.id);
        console.log(`plugin ${prodPlugin.packageName} is deleted`);
      }
    }
    console.log('plugins migration is finished');
  } catch (e) {
    console.warn('migratePlugins error', e);
  }
};

const migration = async () => {
  try {
    const devModelsAndBlocks = await developmentClient.itemTypes.all();
    devModelsAndBlocks.sort(sortModels);
    const prodModelsAndBlocks = await productionClient.itemTypes.all();
    const modelsAndBlocksToCreate = [];
    const modelsAndBlocksToUpdate = [];
    const modelsAndBlocksToDelete = [];
    devModelsAndBlocks.forEach((model) => {
      if (
        prodModelsAndBlocks.some(
          (prodModel) => prodModel.apiKey === model.apiKey
        )
      ) {
        modelsAndBlocksToUpdate.push(model);
      } else {
        modelsAndBlocksToCreate.push(model);
      }
    });
    prodModelsAndBlocks.forEach((model) => {
      if (
        !devModelsAndBlocks.some((devModel) => devModel.apiKey === model.apiKey)
      ) {
        modelsAndBlocksToDelete.push(model);
      }
    });
    await migratePlugins();
    await migrateBlocksAndModels(
      modelsAndBlocksToCreate,
      modelsAndBlocksToUpdate,
      modelsAndBlocksToDelete
    );
    await migrateFieldsets(devModelsAndBlocks);
    await migrateFields(devModelsAndBlocks);
  } catch (e) {
    console.warn('migration error ', e);
  }
};

migration();
