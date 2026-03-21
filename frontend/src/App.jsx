import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch, apiFetchWithRetry, formatError, toJsonString } from './lib/api';
import {
  buildMappingFromFields,
  columnLetter,
  createEmptyMappingFields,
  parseMappingToFields
} from './lib/mapping';
import { Section, Tag } from './components/ui';

const TABS = [
  { id: 'overview', label: 'Огляд' },
  { id: 'suppliers', label: 'Постачальники' },
  { id: 'mapping', label: 'Джерела та мапінг' },
  { id: 'pricing', label: 'Націнки та override' },
  { id: 'data', label: 'Змерджений / Final / Compare' },
  { id: 'jobs', label: 'Джоби та логи' }
];

const SOURCE_TYPES = ['google_sheet', 'csv', 'xml', 'json'];
const MAPPING_KEYS = ['article', 'size', 'quantity', 'price', 'extra'];

function normalizeOptionalNumber(value) {
  if (value === null || typeof value === 'undefined') {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  const number = Number(text);
  if (!Number.isFinite(number)) {
    return null;
  }
  return number;
}

function parsePositiveInt(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.trunc(numeric);
}

function toSourceDraft(source = null) {
  if (!source) {
    return {
      name: '',
      source_type: 'google_sheet',
      source_url: '',
      sheet_name: '',
      is_active: true
    };
  }
  return {
    name: String(source.name || ''),
    source_type: String(source.source_type || 'google_sheet'),
    source_url: String(source.source_url || ''),
    sheet_name: String(source.sheet_name || ''),
    is_active: source.is_active !== false
  };
}

function toSupplierDraft(supplier = null) {
  if (!supplier) {
    return {
      name: '',
      priority: '100',
      markup_percent: '0',
      min_profit_enabled: true,
      min_profit_amount: '0',
      is_active: true,
      markup_rule_set_id: ''
    };
  }
  return {
    name: String(supplier.name || ''),
    priority: String(Number(supplier.priority || 100)),
    markup_percent: String(Number(supplier.markup_percent || 0)),
    min_profit_enabled: supplier.min_profit_enabled !== false,
    min_profit_amount: String(Number(supplier.min_profit_amount || 0)),
    is_active: supplier.is_active !== false,
    markup_rule_set_id:
      supplier.markup_rule_set_id === null || typeof supplier.markup_rule_set_id === 'undefined'
        ? ''
        : String(supplier.markup_rule_set_id)
  };
}

function toPriceOverrideDraft(row = null) {
  if (!row) {
    return {
      id: '',
      article: '',
      size: '',
      price_final: '',
      notes: '',
      is_active: true
    };
  }
  return {
    id: String(row.id),
    article: String(row.article || ''),
    size: String(row.size || ''),
    price_final: String(Number(row.price_final || 0)),
    notes: String(row.notes || ''),
    is_active: row.is_active !== false
  };
}

function parseSourceUrlHint(sourceUrl) {
  const value = String(sourceUrl || '').trim();
  if (!value) {
    return '';
  }
  if (/^[a-zA-Z0-9-_]{25,}$/.test(value)) {
    return 'Google Sheet ID';
  }
  if (value.includes('/spreadsheets/d/')) {
    return 'Google Sheet URL';
  }
  return 'custom URL';
}

function createRuleConditionDraft(priority = 10) {
  return {
    priority: String(priority),
    price_from: '0',
    price_to: '',
    action_type: 'percent',
    action_value: '0',
    is_active: true
  };
}

function toRuleSetDraft(ruleSet = null) {
  if (!ruleSet) {
    return {
      id: '',
      name: '',
      is_active: true,
      conditions: [createRuleConditionDraft(10)]
    };
  }
  const conditions = Array.isArray(ruleSet.conditions)
    ? ruleSet.conditions.map((row, index) => ({
        priority: String(Number(row.priority || (index + 1) * 10)),
        price_from: String(Number(row.price_from || 0)),
        price_to:
          row.price_to === null || typeof row.price_to === 'undefined'
            ? ''
            : String(Number(row.price_to)),
        action_type: String(row.action_type || 'percent'),
        action_value: String(Number(row.action_value || 0)),
        is_active: row.is_active !== false
      }))
    : [createRuleConditionDraft(10)];

  return {
    id: String(ruleSet.id || ''),
    name: String(ruleSet.name || ''),
    is_active: ruleSet.is_active !== false,
    conditions: conditions.length > 0 ? conditions : [createRuleConditionDraft(10)]
  };
}

function normalizeRuleSetPayload(ruleSetDraft) {
  const name = String(ruleSetDraft.name || '').trim();
  if (!name) {
    return { ok: false, error: 'name is required' };
  }
  if (!Array.isArray(ruleSetDraft.conditions) || ruleSetDraft.conditions.length === 0) {
    return { ok: false, error: 'conditions are required' };
  }

  const conditions = [];
  for (let index = 0; index < ruleSetDraft.conditions.length; index += 1) {
    const condition = ruleSetDraft.conditions[index];
    const priority = Number(condition.priority);
    const priceFrom = Number(condition.price_from);
    const actionValue = Number(condition.action_value);
    const priceToRaw = String(condition.price_to || '').trim();
    const priceTo = priceToRaw === '' ? null : Number(priceToRaw);
    const actionType = String(condition.action_type || '').trim();

    if (!Number.isFinite(priority)) {
      return { ok: false, error: `condition #${index + 1}: priority is invalid` };
    }
    if (!Number.isFinite(priceFrom) || priceFrom < 0) {
      return { ok: false, error: `condition #${index + 1}: price_from is invalid` };
    }
    if (priceTo !== null && (!Number.isFinite(priceTo) || priceTo < priceFrom)) {
      return { ok: false, error: `condition #${index + 1}: price_to is invalid` };
    }
    if (actionType !== 'percent' && actionType !== 'fixed_add') {
      return { ok: false, error: `condition #${index + 1}: action_type is invalid` };
    }
    if (!Number.isFinite(actionValue)) {
      return { ok: false, error: `condition #${index + 1}: action_value is invalid` };
    }

    conditions.push({
      priority: Math.trunc(priority),
      price_from: priceFrom,
      price_to: priceTo,
      action_type: actionType,
      action_value: actionValue,
      is_active: condition.is_active !== false
    });
  }

  return {
    ok: true,
    payload: {
      name,
      is_active: ruleSetDraft.is_active !== false,
      conditions
    }
  };
}

export default function App() {
  const [tab, setTab] = useState('overview');
  const [apiStatus, setApiStatus] = useState('checking');
  const [meRole, setMeRole] = useState(null);

  const [stats, setStats] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [logs, setLogs] = useState([]);
  const [logsLevel, setLogsLevel] = useState('');
  const [logsJobId, setLogsJobId] = useState('');
  const [jobsStatus, setJobsStatus] = useState('');
  const [actionStatus, setActionStatus] = useState('');
  const [topStatus, setTopStatus] = useState('');
  const [lastFailedAction, setLastFailedAction] = useState(null);

  const [suppliers, setSuppliers] = useState([]);
  const [supplierSearch, setSupplierSearch] = useState('');
  const [supplierSort, setSupplierSort] = useState('id_asc');
  const [suppliersStatus, setSuppliersStatus] = useState('');
  const [supplierDraft, setSupplierDraft] = useState(() => toSupplierDraft(null));
  const [supplierErrors, setSupplierErrors] = useState({});
  const [editingSupplierId, setEditingSupplierId] = useState('');
  const [supplierFormStatus, setSupplierFormStatus] = useState('');
  const [selectedSupplierIds, setSelectedSupplierIds] = useState([]);
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkDraft, setBulkDraft] = useState({
    apply_markup_percent: false,
    markup_percent: '',
    apply_min_profit: false,
    min_profit_enabled: true,
    min_profit_amount: ''
  });

  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const [sources, setSources] = useState([]);
  const [sourcesStatus, setSourcesStatus] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [sourceDraft, setSourceDraft] = useState(() => toSourceDraft(null));
  const [sourceErrors, setSourceErrors] = useState({});
  const [editingSourceId, setEditingSourceId] = useState('');
  const [sourceFormStatus, setSourceFormStatus] = useState('');
  const [sourceSheets, setSourceSheets] = useState([]);
  const [selectedSheetName, setSelectedSheetName] = useState('');
  const [sourceSheetsStatus, setSourceSheetsStatus] = useState('');
  const [sourcePreview, setSourcePreview] = useState({
    headers: [],
    sampleRows: [],
    headerRow: 1,
    sheetName: '',
    status: ''
  });

  const [mappingText, setMappingText] = useState('{}');
  const [mappingComment, setMappingComment] = useState('');
  const [mappingHeaderRow, setMappingHeaderRow] = useState('1');
  const [mappingErrors, setMappingErrors] = useState({});
  const [mappingStatus, setMappingStatus] = useState('');
  const [mappingFields, setMappingFields] = useState(() => createEmptyMappingFields());

  const [markupRuleSets, setMarkupRuleSets] = useState([]);
  const [globalRuleSetId, setGlobalRuleSetId] = useState(null);
  const [pricingStatus, setPricingStatus] = useState('');
  const [pricingApplyRuleSetId, setPricingApplyRuleSetId] = useState('');
  const [pricingApplyScope, setPricingApplyScope] = useState('suppliers');
  const [ruleSetDraft, setRuleSetDraft] = useState(() => toRuleSetDraft(null));
  const [ruleSetErrors, setRuleSetErrors] = useState({});
  const [ruleSetStatus, setRuleSetStatus] = useState('');

  const [priceOverrides, setPriceOverrides] = useState({ rows: [], total: 0, status: '' });
  const [priceOverrideFilters, setPriceOverrideFilters] = useState({
    search: '',
    limit: '50',
    offset: '0'
  });
  const [priceOverrideDraft, setPriceOverrideDraft] = useState(() => toPriceOverrideDraft(null));
  const [priceOverrideErrors, setPriceOverrideErrors] = useState({});
  const [priceOverrideStatus, setPriceOverrideStatus] = useState('');

  const [mergedState, setMergedState] = useState({ rows: [], total: 0, status: '' });
  const [finalState, setFinalState] = useState({ rows: [], total: 0, status: '' });
  const [compareState, setCompareState] = useState({ rows: [], total: 0, status: '' });
  const [dataFilters, setDataFilters] = useState({
    limit: '50',
    offset: '0',
    search: '',
    supplierId: '',
    missingOnly: true,
    mergedSort: 'article_asc',
    finalSort: 'article_asc'
  });
  const [activeDataView, setActiveDataView] = useState('merged');
  const [jobDetails, setJobDetails] = useState({
    loading: false,
    error: '',
    jobId: null,
    payload: null
  });

  const [actionForm, setActionForm] = useState({
    sourceId: '',
    supplierId: '',
    storeSupplier: '',
    resumeFromJobId: '',
    resumeLatest: false,
    retentionDays: '10',
    updatePipelineSupplier: ''
  });

  const isReadOnly = meRole === 'viewer';
  const readyForImport = readiness?.gates?.ready_for_store_import === true;

  const mappingColumnOptions = useMemo(() => {
    if (sourcePreview.headers.length > 0) {
      return sourcePreview.headers.map((header, index) => ({
        value: String(index + 1),
        label: `${columnLetter(index + 1)} (${index + 1}) ${header || '[blank]'}`
      }));
    }
    return Array.from({ length: 30 }, (_, index) => ({
      value: String(index + 1),
      label: `${columnLetter(index + 1)} (${index + 1})`
    }));
  }, [sourcePreview.headers]);

  const recentErrorLogs = useMemo(
    () => logs.filter((item) => String(item.level || '').toLowerCase() === 'error').slice(0, 8),
    [logs]
  );

  const rememberFailedAction = (label, run) => {
    setLastFailedAction({
      label,
      run,
      at: Date.now()
    });
  };

  const clearFailedAction = () => {
    setLastFailedAction(null);
  };

  const runMutationWithRetryUX = async (label, run) => {
    try {
      const result = await run();
      setTopStatus('');
      clearFailedAction();
      return result;
    } catch (error) {
      rememberFailedAction(label, run);
      setTopStatus(`Failed: ${label}. Use "Retry failed".`);
      throw error;
    }
  };

  const confirmWithKeyword = ({ title, details, keyword }) => {
    const promptText = [title, details, `Введіть "${keyword}" для підтвердження.`]
      .filter(Boolean)
      .join('\n');
    const answer = window.prompt(promptText);
    return String(answer || '').trim() === keyword;
  };

  const retryLastFailedAction = async () => {
    if (!lastFailedAction?.run) {
      return;
    }
    setTopStatus(`Retry: ${lastFailedAction.label}...`);
    try {
      await lastFailedAction.run();
      setTopStatus(`Retry success: ${lastFailedAction.label}`);
      clearFailedAction();
      await refreshCore();
    } catch (error) {
      setTopStatus(`Retry failed: ${formatError(error)}`);
      rememberFailedAction(lastFailedAction.label, lastFailedAction.run);
    }
  };

  const refreshCore = async () => {
    try {
      const logsQuery = new URLSearchParams();
      logsQuery.set('limit', '50');
      if (logsLevel.trim()) {
        logsQuery.set('level', logsLevel.trim());
      }
      const parsedLogJobId = parsePositiveInt(logsJobId);
      if (parsedLogJobId) {
        logsQuery.set('jobId', String(parsedLogJobId));
      }
      const [statsPayload, readinessPayload, jobsPayload, logsPayload] = await Promise.all([
        apiFetch('/stats'),
        apiFetch('/backend-readiness?store=cscart&maxMirrorAgeMinutes=120'),
        apiFetch('/jobs?limit=25'),
        apiFetch(`/logs?${logsQuery.toString()}`)
      ]);
      setStats(statsPayload);
      setReadiness(readinessPayload);
      setJobs(Array.isArray(jobsPayload?.items) ? jobsPayload.items : []);
      setLogs(Array.isArray(logsPayload) ? logsPayload : []);
      setJobsStatus(`Оновлено: ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      setJobsStatus(formatError(error));
    }
  };

  const refreshSuppliers = async () => {
    setSuppliersStatus('Завантаження постачальників...');
    try {
      const query = new URLSearchParams();
      if (supplierSearch.trim()) {
        query.set('search', supplierSearch.trim());
      }
      query.set('sort', supplierSort);
      const data = await apiFetch(`/suppliers?${query.toString()}`);
      const rows = Array.isArray(data) ? data : [];
      setSuppliers(rows);
      setSuppliersStatus(`Знайдено: ${rows.length}`);

      if (selectedSupplierId && !rows.find((item) => String(item.id) === String(selectedSupplierId))) {
        setSelectedSupplierId('');
        setSelectedSourceId('');
      }
      setSelectedSupplierIds((prev) =>
        prev.filter((id) => rows.some((supplier) => String(supplier.id) === String(id)))
      );
    } catch (error) {
      setSuppliersStatus(formatError(error));
    }
  };

  const refreshSources = async (supplierIdRaw) => {
    const supplierId = Number(supplierIdRaw);
    if (!Number.isFinite(supplierId) || supplierId <= 0) {
      setSources([]);
      setSelectedSourceId('');
      setSourceDraft(toSourceDraft(null));
      setEditingSourceId('');
      setSourceSheets([]);
      setSelectedSheetName('');
      setSourcePreview({
        headers: [],
        sampleRows: [],
        headerRow: 1,
        sheetName: '',
        status: ''
      });
      return;
    }
    setSourcesStatus('Завантаження джерел...');
    try {
      const data = await apiFetch(`/sources?supplierId=${supplierId}`);
      const rows = Array.isArray(data) ? data : [];
      setSources(rows);
      if (!rows.find((item) => String(item.id) === String(selectedSourceId))) {
        setSelectedSourceId(rows[0] ? String(rows[0].id) : '');
      }
      setSourcesStatus(`Джерел: ${rows.length}`);
    } catch (error) {
      setSourcesStatus(formatError(error));
    }
  };

  const refreshMapping = async (supplierIdRaw, sourceIdRaw) => {
    const supplierId = Number(supplierIdRaw);
    const sourceId = Number(sourceIdRaw);
    if (!Number.isFinite(supplierId) || supplierId <= 0 || !Number.isFinite(sourceId) || sourceId <= 0) {
      setMappingText('{}');
      setMappingComment('');
      setMappingHeaderRow('1');
      setMappingFields(createEmptyMappingFields());
      return;
    }
    setMappingStatus('Завантаження мапінгу...');
    try {
      const data = await apiFetch(`/mappings/${supplierId}?sourceId=${sourceId}`);
      const mapping = data?.mapping && typeof data.mapping === 'object' ? data.mapping : {};
      setMappingText(toJsonString(mapping));
      setMappingComment(String(data?.comment || ''));
      setMappingHeaderRow(String(Number(data?.header_row || 1)));
      setMappingFields(parseMappingToFields(mapping));
      setMappingErrors({});
      setMappingStatus('Мапінг завантажено');
    } catch (error) {
      setMappingStatus(formatError(error));
    }
  };

  const refreshMarkupRuleSets = async () => {
    setPricingStatus('Завантаження rule sets...');
    try {
      const data = await apiFetch('/markup-rule-sets');
      const rows = Array.isArray(data?.rule_sets) ? data.rule_sets : [];
      const globalId =
        data?.global_rule_set_id === null || typeof data?.global_rule_set_id === 'undefined'
          ? null
          : Number(data.global_rule_set_id);
      setMarkupRuleSets(rows);
      setGlobalRuleSetId(globalId);
      if (!pricingApplyRuleSetId && rows.length > 0) {
        setPricingApplyRuleSetId(String(rows[0].id));
      }
      if (ruleSetDraft.id) {
        const matched = rows.find((item) => String(item.id) === String(ruleSetDraft.id));
        if (matched) {
          setRuleSetDraft(toRuleSetDraft(matched));
        }
      }
      setPricingStatus(`Rule sets: ${rows.length}`);
    } catch (error) {
      setPricingStatus(formatError(error));
    }
  };

  const refreshPriceOverrides = async () => {
    setPriceOverrides((prev) => ({ ...prev, status: 'Завантаження...' }));
    try {
      const query = new URLSearchParams();
      query.set('limit', priceOverrideFilters.limit || '50');
      query.set('offset', priceOverrideFilters.offset || '0');
      if (priceOverrideFilters.search.trim()) {
        query.set('search', priceOverrideFilters.search.trim());
      }
      const result = await apiFetch(`/price-overrides?${query.toString()}`);
      setPriceOverrides({
        rows: Array.isArray(result?.rows) ? result.rows : [],
        total: Number(result?.total || 0),
        status: `total=${Number(result?.total || 0)}`
      });
    } catch (error) {
      setPriceOverrides((prev) => ({ ...prev, status: formatError(error) }));
    }
  };

  const validateSupplierDraft = () => {
    const errors = {};
    if (!supplierDraft.name.trim()) {
      errors.name = 'Назва постачальника обовʼязкова';
    }
    if (normalizeOptionalNumber(supplierDraft.priority) === null) {
      errors.priority = 'Priority має бути числом';
    }
    if (normalizeOptionalNumber(supplierDraft.markup_percent) === null) {
      errors.markup_percent = 'Markup % має бути числом';
    }
    if (supplierDraft.min_profit_enabled && normalizeOptionalNumber(supplierDraft.min_profit_amount) === null) {
      errors.min_profit_amount = 'Min profit amount має бути числом';
    }
    if (supplierDraft.markup_rule_set_id.trim()) {
      const parsedRuleSetId = parsePositiveInt(supplierDraft.markup_rule_set_id);
      if (!parsedRuleSetId) {
        errors.markup_rule_set_id = 'Markup rule set id має бути додатнім числом';
      }
    }
    return errors;
  };

  const validateSourceDraft = () => {
    const errors = {};
    if (!sourceDraft.source_type.trim()) {
      errors.source_type = 'source_type обовʼязкове';
    }
    if (!sourceDraft.source_url.trim()) {
      errors.source_url = 'source_url обовʼязкове';
    }
    return errors;
  };

  const validateMappingDraft = () => {
    const errors = {};
    const headerRow = parsePositiveInt(mappingHeaderRow);
    if (!headerRow) {
      errors.header_row = 'Header row має бути додатнім числом';
    }
    if (!mappingText.trim()) {
      errors.mapping = 'Mapping JSON обовʼязковий';
      return errors;
    }
    try {
      const parsed = JSON.parse(mappingText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.mapping = 'Mapping має бути JSON object';
      }
    } catch (_error) {
      errors.mapping = 'Некоректний JSON';
    }
    return errors;
  };

  const validatePriceOverrideDraft = () => {
    const errors = {};
    if (!priceOverrideDraft.id && !priceOverrideDraft.article.trim()) {
      errors.article = 'article обовʼязковий';
    }
    if (priceOverrideDraft.price_final.trim() !== '') {
      if (normalizeOptionalNumber(priceOverrideDraft.price_final) === null) {
        errors.price_final = 'price_final має бути числом';
      }
    } else if (!priceOverrideDraft.id) {
      errors.price_final = 'price_final обовʼязковий';
    }
    return errors;
  };

  const saveSupplier = async () => {
    const errors = validateSupplierDraft();
    setSupplierErrors(errors);
    if (Object.keys(errors).length > 0) {
      setSupplierFormStatus('Перевірте поля форми постачальника');
      return;
    }
    const name = supplierDraft.name.trim();
    const payload = {
      name,
      priority: Number(supplierDraft.priority),
      markup_percent: Number(supplierDraft.markup_percent),
      min_profit_enabled: supplierDraft.min_profit_enabled,
      min_profit_amount: Number(supplierDraft.min_profit_amount || 0),
      is_active: supplierDraft.is_active,
      markup_rule_set_id:
        supplierDraft.markup_rule_set_id.trim() === ''
          ? null
          : Number(supplierDraft.markup_rule_set_id)
    };
    setSupplierFormStatus('Збереження постачальника...');
    try {
      await runMutationWithRetryUX(
        editingSupplierId ? `save_supplier_${editingSupplierId}` : 'create_supplier',
        () =>
          editingSupplierId
            ? apiFetchWithRetry(
                `/suppliers/${editingSupplierId}`,
                {
                  method: 'PUT',
                  body: JSON.stringify(payload)
                },
                { retries: 1 }
              )
            : apiFetchWithRetry(
                '/suppliers',
                {
                  method: 'POST',
                  body: JSON.stringify(payload)
                },
                { retries: 1 }
              )
      );
      setSupplierFormStatus('Постачальника збережено');
      setSupplierErrors({});
      setEditingSupplierId('');
      setSupplierDraft(toSupplierDraft(null));
      await refreshSuppliers();
    } catch (error) {
      setSupplierFormStatus(formatError(error));
    }
  };

  const deleteSupplier = async (supplierId) => {
    const keyword = `DELETE_SUPPLIER_${supplierId}`;
    const confirmed = confirmWithKeyword({
      title: `Видалення постачальника #${supplierId}`,
      details: 'Це видалить постачальника і повʼязані налаштування.',
      keyword
    });
    if (!confirmed) {
      setSupplierFormStatus('Видалення скасовано (не пройдено preflight)');
      return;
    }
    setSupplierFormStatus(`Видалення #${supplierId}...`);
    try {
      await runMutationWithRetryUX(`delete_supplier_${supplierId}`, () =>
        apiFetchWithRetry(
          `/suppliers/${supplierId}`,
          { method: 'DELETE' },
          { retries: 1 }
        )
      );
      setSupplierFormStatus(`Постачальника #${supplierId} видалено`);
      if (editingSupplierId === String(supplierId)) {
        setEditingSupplierId('');
        setSupplierDraft(toSupplierDraft(null));
      }
      if (selectedSupplierId === String(supplierId)) {
        setSelectedSupplierId('');
      }
      await refreshSuppliers();
    } catch (error) {
      setSupplierFormStatus(formatError(error));
    }
  };

  const saveSupplierBulk = async () => {
    if (selectedSupplierIds.length === 0) {
      setBulkStatus('Оберіть постачальників для bulk update');
      return;
    }
    const payload = {
      supplier_ids: selectedSupplierIds
    };
    if (bulkDraft.apply_markup_percent) {
      const markup = normalizeOptionalNumber(bulkDraft.markup_percent);
      if (markup === null) {
        setBulkStatus('markup_percent має бути числом');
        return;
      }
      payload.markup_percent = markup;
    }
    if (bulkDraft.apply_min_profit) {
      payload.min_profit_enabled = bulkDraft.min_profit_enabled;
      const minProfitAmount = normalizeOptionalNumber(bulkDraft.min_profit_amount);
      if (bulkDraft.min_profit_enabled && minProfitAmount === null) {
        setBulkStatus('min_profit_amount має бути числом');
        return;
      }
      if (bulkDraft.min_profit_enabled) {
        payload.min_profit_amount = minProfitAmount;
      } else {
        payload.min_profit_amount = 0;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(payload, 'markup_percent') &&
      !Object.prototype.hasOwnProperty.call(payload, 'min_profit_enabled')
    ) {
      setBulkStatus('Оберіть хоча б одне поле для bulk update');
      return;
    }

    setBulkStatus('Виконання bulk update...');
    try {
      const result = await runMutationWithRetryUX('bulk_update_suppliers', () =>
        apiFetchWithRetry(
          '/suppliers/bulk',
          {
            method: 'PUT',
            body: JSON.stringify(payload)
          },
          { retries: 1 }
        )
      );
      setBulkStatus(`Оновлено: ${Number(result?.updated || 0)}`);
      await refreshSuppliers();
    } catch (error) {
      setBulkStatus(formatError(error));
    }
  };

  const saveSource = async () => {
    const supplierId = Number(selectedSupplierId);
    if (!Number.isFinite(supplierId) || supplierId <= 0) {
      setSourceFormStatus('Оберіть постачальника');
      return;
    }
    const errors = validateSourceDraft();
    setSourceErrors(errors);
    if (Object.keys(errors).length > 0) {
      setSourceFormStatus('Перевірте поля форми джерела');
      return;
    }
    const sourceType = sourceDraft.source_type.trim();
    const sourceUrl = sourceDraft.source_url.trim();

    const payload = {
      supplier_id: supplierId,
      name: sourceDraft.name.trim() || null,
      source_type: sourceType,
      source_url: sourceUrl,
      sheet_name: sourceDraft.sheet_name.trim() || null,
      is_active: sourceDraft.is_active
    };

    setSourceFormStatus('Збереження джерела...');
    try {
      await runMutationWithRetryUX(
        editingSourceId ? `save_source_${editingSourceId}` : 'create_source',
        () =>
          editingSourceId
            ? apiFetchWithRetry(
                `/sources/${editingSourceId}`,
                {
                  method: 'PUT',
                  body: JSON.stringify(payload)
                },
                { retries: 1 }
              )
            : apiFetchWithRetry(
                '/sources',
                {
                  method: 'POST',
                  body: JSON.stringify(payload)
                },
                { retries: 1 }
              )
      );
      setSourceFormStatus('Джерело збережено');
      setSourceErrors({});
      setSourceDraft(toSourceDraft(null));
      setEditingSourceId('');
      await refreshSources(selectedSupplierId);
    } catch (error) {
      setSourceFormStatus(formatError(error));
    }
  };

  const deleteSource = async (sourceId) => {
    const keyword = `DELETE_SOURCE_${sourceId}`;
    const confirmed = confirmWithKeyword({
      title: `Видалення джерела #${sourceId}`,
      details: 'Перевірте, що це джерело більше не використовується у pipeline.',
      keyword
    });
    if (!confirmed) {
      setSourceFormStatus('Видалення скасовано (не пройдено preflight)');
      return;
    }
    setSourceFormStatus(`Видалення source #${sourceId}...`);
    try {
      await runMutationWithRetryUX(`delete_source_${sourceId}`, () =>
        apiFetchWithRetry(
          `/sources/${sourceId}`,
          { method: 'DELETE' },
          { retries: 1 }
        )
      );
      setSourceFormStatus(`Source #${sourceId} видалено`);
      if (editingSourceId === String(sourceId)) {
        setEditingSourceId('');
        setSourceDraft(toSourceDraft(null));
      }
      if (selectedSourceId === String(sourceId)) {
        setSelectedSourceId('');
      }
      await refreshSources(selectedSupplierId);
    } catch (error) {
      setSourceFormStatus(formatError(error));
    }
  };

  const loadSourceSheets = async () => {
    const sourceId = Number(selectedSourceId);
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      setSourceSheetsStatus('Оберіть джерело');
      return;
    }
    setSourceSheetsStatus('Завантаження аркушів...');
    try {
      const result = await apiFetch(`/source-sheets?sourceId=${sourceId}`);
      const sheets = Array.isArray(result?.sheets) ? result.sheets : [];
      const selected =
        typeof result?.selectedSheetName === 'string' && result.selectedSheetName.trim()
          ? result.selectedSheetName.trim()
          : sheets[0] || '';
      setSourceSheets(sheets);
      setSelectedSheetName(selected);
      if (selected) {
        setSourceDraft((prev) => ({ ...prev, sheet_name: selected }));
      }
      setSourceSheetsStatus(`Аркушів: ${sheets.length}`);
    } catch (error) {
      setSourceSheetsStatus(formatError(error));
    }
  };

  const loadSourcePreview = async () => {
    const sourceId = Number(selectedSourceId);
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      setSourcePreview((prev) => ({ ...prev, status: 'Оберіть джерело' }));
      return;
    }
    const headerRow = Number(mappingHeaderRow || 1);
    const query = new URLSearchParams();
    query.set('sourceId', String(sourceId));
    query.set('headerRow', Number.isFinite(headerRow) && headerRow > 0 ? String(headerRow) : '1');
    if (selectedSheetName.trim()) {
      query.set('sheetName', selectedSheetName.trim());
    }
    setSourcePreview((prev) => ({ ...prev, status: 'Завантаження preview...' }));
    try {
      const result = await apiFetch(`/source-preview?${query.toString()}`);
      setSourcePreview({
        headers: Array.isArray(result?.headers) ? result.headers : [],
        sampleRows: Array.isArray(result?.sampleRows) ? result.sampleRows : [],
        headerRow: Number(result?.headerRow || 1),
        sheetName: String(result?.sheetName || ''),
        status: 'Preview завантажено'
      });
      if (result?.sheetName) {
        setSelectedSheetName(String(result.sheetName));
      }
    } catch (error) {
      setSourcePreview((prev) => ({ ...prev, status: formatError(error) }));
    }
  };

  const saveMapping = async () => {
    const supplierId = Number(selectedSupplierId);
    const sourceId = Number(selectedSourceId);
    if (!Number.isFinite(supplierId) || supplierId <= 0 || !Number.isFinite(sourceId) || sourceId <= 0) {
      setMappingStatus('Оберіть постачальника і джерело');
      return;
    }
    const errors = validateMappingDraft();
    setMappingErrors(errors);
    if (Object.keys(errors).length > 0) {
      setMappingStatus('Перевірте поля мапінгу');
      return;
    }

    let parsedMapping;
    try {
      parsedMapping = JSON.parse(mappingText);
    } catch (error) {
      setMappingStatus(`JSON помилка: ${formatError(error)}`);
      return;
    }

    setMappingStatus('Збереження мапінгу...');
    try {
      await runMutationWithRetryUX(`save_mapping_${supplierId}_${sourceId}`, () =>
        apiFetchWithRetry(
          `/mappings/${supplierId}`,
          {
            method: 'POST',
            body: JSON.stringify({
              source_id: sourceId,
              mapping: parsedMapping,
              header_row: Number(mappingHeaderRow),
              comment: mappingComment,
              mapping_meta: {
                source_id: sourceId,
                sheet_name: selectedSheetName || null,
                header_row: Number(mappingHeaderRow)
              }
            })
          },
          { retries: 1 }
        )
      );
      setMappingStatus('Мапінг збережено');
      setMappingErrors({});
    } catch (error) {
      setMappingStatus(formatError(error));
    }
  };

  const applyBuilderToJson = () => {
    const mapping = buildMappingFromFields(mappingFields);
    setMappingText(toJsonString(mapping));
    setMappingErrors((prev) => ({ ...prev, mapping: undefined }));
    setMappingStatus('Builder перенесено в JSON');
  };

  const updateMappingField = (key, patch) => {
    setMappingFields((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        ...patch
      }
    }));
  };

  const savePriceOverride = async () => {
    const errors = validatePriceOverrideDraft();
    setPriceOverrideErrors(errors);
    if (Object.keys(errors).length > 0) {
      setPriceOverrideStatus('Перевірте поля override');
      return;
    }
    const article = priceOverrideDraft.article.trim();
    const priceFinal = normalizeOptionalNumber(priceOverrideDraft.price_final);

    setPriceOverrideStatus('Збереження override...');
    try {
      if (priceOverrideDraft.id) {
        await runMutationWithRetryUX(`update_price_override_${priceOverrideDraft.id}`, () =>
          apiFetchWithRetry(
            `/price-overrides/${priceOverrideDraft.id}`,
            {
              method: 'PUT',
              body: JSON.stringify({
                price_final: priceFinal === null ? undefined : priceFinal,
                notes: priceOverrideDraft.notes.trim() || null,
                is_active: priceOverrideDraft.is_active
              })
            },
            { retries: 1 }
          )
        );
      } else {
        await runMutationWithRetryUX('create_price_override', () =>
          apiFetchWithRetry(
            '/price-overrides',
            {
              method: 'POST',
              body: JSON.stringify({
                article,
                size: priceOverrideDraft.size.trim() || null,
                price_final: priceFinal,
                notes: priceOverrideDraft.notes.trim() || null
              })
            },
            { retries: 1 }
          )
        );
      }
      setPriceOverrideStatus('Override збережено');
      setPriceOverrideErrors({});
      setPriceOverrideDraft(toPriceOverrideDraft(null));
      await refreshPriceOverrides();
    } catch (error) {
      setPriceOverrideStatus(formatError(error));
    }
  };

  const setDefaultMarkupRuleSet = async (ruleSetId) => {
    setPricingStatus(`Set default #${ruleSetId}...`);
    try {
      const result = await runMutationWithRetryUX(`set_default_ruleset_${ruleSetId}`, () =>
        apiFetchWithRetry(
          '/markup-rule-sets/default',
          {
            method: 'POST',
            body: JSON.stringify({ rule_set_id: Number(ruleSetId) })
          },
          { retries: 1 }
        )
      );
      setGlobalRuleSetId(Number(result?.global_rule_set_id || 0) || null);
      setPricingStatus(`Default rule set: #${Number(result?.global_rule_set_id || 0)}`);
      await refreshSuppliers();
    } catch (error) {
      setPricingStatus(formatError(error));
    }
  };

  const applyMarkupRuleSet = async () => {
    const ruleSetId = Number(pricingApplyRuleSetId);
    if (!Number.isFinite(ruleSetId) || ruleSetId <= 0) {
      setPricingStatus('Оберіть rule set');
      return;
    }
    if (pricingApplyScope === 'suppliers' && selectedSupplierIds.length === 0) {
      setPricingStatus('Для scope=suppliers оберіть supplier_ids');
      return;
    }
    const payload = {
      scope: pricingApplyScope,
      rule_set_id: ruleSetId
    };
    if (pricingApplyScope === 'suppliers') {
      payload.supplier_ids = selectedSupplierIds;
    } else {
      const confirmed = confirmWithKeyword({
        title: 'Застосування rule set до ALL suppliers',
        details: 'Це змінить правило націнки для всіх постачальників.',
        keyword: 'APPLY_ALL_SUPPLIERS'
      });
      if (!confirmed) {
        setPricingStatus('Apply скасовано (не пройдено preflight)');
        return;
      }
    }
    setPricingStatus('Apply rule set...');
    try {
      const result = await runMutationWithRetryUX(
        `apply_ruleset_${ruleSetId}_${pricingApplyScope}`,
        () =>
          apiFetchWithRetry(
            '/markup-rule-sets/apply',
            {
              method: 'POST',
              body: JSON.stringify(payload)
            },
            { retries: 1 }
          )
      );
      setPricingStatus(
        `Apply завершено: scope=${result?.scope || '-'}, updated=${Number(result?.updated_suppliers || 0)}`
      );
      await refreshSuppliers();
    } catch (error) {
      setPricingStatus(formatError(error));
    }
  };

  const startCreateRuleSet = () => {
    setRuleSetDraft(toRuleSetDraft(null));
    setRuleSetErrors({});
    setRuleSetStatus('Створення нового rule set');
  };

  const startEditRuleSet = (ruleSetId) => {
    const matched = markupRuleSets.find((item) => String(item.id) === String(ruleSetId));
    if (!matched) {
      setRuleSetStatus('Rule set не знайдено');
      return;
    }
    setRuleSetDraft(toRuleSetDraft(matched));
    setRuleSetErrors({});
    setRuleSetStatus(`Редагування #${matched.id}`);
  };

  const updateRuleCondition = (index, patch) => {
    setRuleSetDraft((prev) => ({
      ...prev,
      conditions: prev.conditions.map((item, conditionIndex) =>
        conditionIndex === index ? { ...item, ...patch } : item
      )
    }));
  };

  const addRuleCondition = () => {
    setRuleSetDraft((prev) => {
      const nextPriority =
        prev.conditions.length > 0
          ? Number(prev.conditions[prev.conditions.length - 1].priority || 0) + 10
          : 10;
      return {
        ...prev,
        conditions: [...prev.conditions, createRuleConditionDraft(nextPriority)]
      };
    });
  };

  const removeRuleCondition = (index) => {
    setRuleSetDraft((prev) => {
      if (prev.conditions.length <= 1) {
        return prev;
      }
      return {
        ...prev,
        conditions: prev.conditions.filter((_item, conditionIndex) => conditionIndex !== index)
      };
    });
  };

  const saveRuleSet = async () => {
    setRuleSetErrors({});
    const normalized = normalizeRuleSetPayload(ruleSetDraft);
    if (!normalized.ok) {
      const baseError = String(normalized.error || '');
      const conditionMatch = baseError.match(/^condition #(\d+):\s*(.+)$/i);
      if (conditionMatch) {
        const index = Number(conditionMatch[1]) - 1;
        if (Number.isFinite(index) && index >= 0) {
          setRuleSetErrors({
            [`condition_${index}`]: conditionMatch[2]
          });
        }
      } else {
        setRuleSetErrors({ base: baseError });
      }
      setRuleSetStatus(normalized.error);
      return;
    }
    setRuleSetStatus('Збереження rule set...');
    try {
      const result = await runMutationWithRetryUX(
        ruleSetDraft.id ? `update_ruleset_${ruleSetDraft.id}` : 'create_ruleset',
        () =>
          ruleSetDraft.id
            ? apiFetchWithRetry(
                `/markup-rule-sets/${ruleSetDraft.id}`,
                {
                  method: 'PUT',
                  body: JSON.stringify(normalized.payload)
                },
                { retries: 1 }
              )
            : apiFetchWithRetry(
                '/markup-rule-sets',
                {
                  method: 'POST',
                  body: JSON.stringify(normalized.payload)
                },
                { retries: 1 }
              )
      );
      const savedId = Number(result?.rule_set?.id || 0);
      await refreshMarkupRuleSets();
      if (savedId > 0) {
        setPricingApplyRuleSetId(String(savedId));
        startEditRuleSet(savedId);
      } else {
        startCreateRuleSet();
      }
      setRuleSetStatus('Rule set збережено');
    } catch (error) {
      setRuleSetStatus(formatError(error));
    }
  };

  const loadMerged = async () => {
    setMergedState((prev) => ({ ...prev, status: 'Завантаження...' }));
    try {
      const query = new URLSearchParams();
      query.set('limit', dataFilters.limit || '50');
      query.set('offset', dataFilters.offset || '0');
      if (dataFilters.search.trim()) {
        query.set('search', dataFilters.search.trim());
      }
      query.set('sort', dataFilters.mergedSort || 'article_asc');
      const result = await apiFetch(`/merged-preview?${query.toString()}`);
      setMergedState({
        rows: Array.isArray(result?.rows) ? result.rows : [],
        total: Number(result?.total || 0),
        status: `total=${Number(result?.total || 0)}`
      });
    } catch (error) {
      setMergedState((prev) => ({ ...prev, status: formatError(error) }));
    }
  };

  const loadFinal = async () => {
    setFinalState((prev) => ({ ...prev, status: 'Завантаження...' }));
    try {
      const query = new URLSearchParams();
      query.set('limit', dataFilters.limit || '50');
      query.set('offset', dataFilters.offset || '0');
      if (dataFilters.search.trim()) {
        query.set('search', dataFilters.search.trim());
      }
      if (dataFilters.supplierId.trim()) {
        query.set('supplierId', dataFilters.supplierId.trim());
      }
      query.set('sort', dataFilters.finalSort || 'article_asc');
      const result = await apiFetch(`/final-preview?${query.toString()}`);
      setFinalState({
        rows: Array.isArray(result?.rows) ? result.rows : [],
        total: Number(result?.total || 0),
        status: `total=${Number(result?.total || 0)}`
      });
    } catch (error) {
      setFinalState((prev) => ({ ...prev, status: formatError(error) }));
    }
  };

  const shiftDataOffset = (direction) => {
    setDataFilters((prev) => {
      const limit = Math.max(1, Number(prev.limit || 50));
      const offset = Math.max(0, Number(prev.offset || 0) + direction * limit);
      return {
        ...prev,
        offset: String(offset)
      };
    });
  };

  const openJobDetails = async (jobId) => {
    const normalizedId = Number(jobId);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      setJobDetails({
        loading: false,
        error: 'jobId is invalid',
        jobId: null,
        payload: null
      });
      return;
    }
    setJobDetails({
      loading: true,
      error: '',
      jobId: normalizedId,
      payload: null
    });
    try {
      const payload = await apiFetch(`/jobs/${normalizedId}`);
      setJobDetails({
        loading: false,
        error: '',
        jobId: normalizedId,
        payload
      });
    } catch (error) {
      setJobDetails({
        loading: false,
        error: formatError(error),
        jobId: normalizedId,
        payload: null
      });
    }
  };

  const closeJobDetails = () => {
    setJobDetails({
      loading: false,
      error: '',
      jobId: null,
      payload: null
    });
  };

  const loadCompare = async () => {
    setCompareState((prev) => ({ ...prev, status: 'Завантаження...' }));
    try {
      const query = new URLSearchParams();
      query.set('store', 'cscart');
      query.set('limit', dataFilters.limit || '50');
      query.set('offset', dataFilters.offset || '0');
      query.set('missingOnly', dataFilters.missingOnly ? 'true' : 'false');
      if (dataFilters.search.trim()) {
        query.set('search', dataFilters.search.trim());
      }
      if (dataFilters.supplierId.trim()) {
        query.set('supplierId', dataFilters.supplierId.trim());
      }
      const result = await apiFetch(`/compare-preview?${query.toString()}`);
      setCompareState({
        rows: Array.isArray(result?.rows) ? result.rows : [],
        total: Number(result?.total || 0),
        status: `total=${Number(result?.total || 0)}`
      });
    } catch (error) {
      setCompareState((prev) => ({ ...prev, status: formatError(error) }));
    }
  };

  const runJob = async (label, path, payload = {}) => {
    setActionStatus(`${label}: запуск...`);
    try {
      const result = await runMutationWithRetryUX(`job_${label}`, () =>
        apiFetchWithRetry(
          path,
          {
            method: 'POST',
            body: JSON.stringify(payload)
          },
          { retries: 1 }
        )
      );
      setActionStatus(`${label}: ${toJsonString(result)}`);
      await refreshCore();
    } catch (error) {
      setActionStatus(`${label}: ${formatError(error)}`);
    }
  };

  const runStoreImport = async () => {
    const body = {};
    if (actionForm.storeSupplier.trim()) {
      body.supplier = actionForm.storeSupplier.trim();
    }
    if (actionForm.resumeLatest) {
      body.resumeLatest = true;
    }
    if (actionForm.resumeFromJobId.trim()) {
      body.resumeFromJobId = Number(actionForm.resumeFromJobId.trim());
    }
    await runJob('store_import', '/jobs/store-import', body);
  };

  const runCleanupWithPreflight = async () => {
    const retentionDays = Number(actionForm.retentionDays);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      setActionStatus('cleanup: retentionDays must be a positive number');
      return;
    }
    const keyword = `CLEANUP_${Math.trunc(retentionDays)}`;
    const confirmed = confirmWithKeyword({
      title: `Cleanup run (retentionDays=${Math.trunc(retentionDays)})`,
      details:
        'Операція видалить старі logs/jobs/дані за правилами retention. Перевірте значення.',
      keyword
    });
    if (!confirmed) {
      setActionStatus('cleanup: скасовано (не пройдено preflight)');
      return;
    }
    await runJob('cleanup', '/jobs/cleanup', {
      retentionDays: Math.trunc(retentionDays)
    });
  };

  const cancelJob = async (jobId) => {
    await runJob(`cancel #${jobId}`, `/jobs/${jobId}/cancel`, {
      reason: 'Canceled from React admin UI'
    });
  };

  const logout = async () => {
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      window.location.href = '/admin/login';
    }
  };

  useEffect(() => {
    const boot = async () => {
      try {
        const [health, me] = await Promise.all([
          fetch('/health', { credentials: 'same-origin' }),
          apiFetch('/me')
        ]);
        setApiStatus(health.ok ? 'ok' : 'error');
        setMeRole(me?.role || null);
      } catch (_error) {
        setApiStatus('error');
      }
      await Promise.all([
        refreshCore(),
        refreshSuppliers(),
        refreshMarkupRuleSets(),
        refreshPriceOverrides()
      ]);
    };
    void boot();
  }, []);

  useEffect(() => {
    void refreshSources(selectedSupplierId);
  }, [selectedSupplierId]);

  useEffect(() => {
    void refreshMapping(selectedSupplierId, selectedSourceId);
  }, [selectedSupplierId, selectedSourceId]);

  const renderPreviewTable = (rows, columns, emptyLabel) => {
    if (!Array.isArray(rows) || rows.length === 0) {
      return <div className="empty-preview">{emptyLabel}</div>;
    }
    return (
      <div className="preview-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`row_${rowIndex}`}>
                {columns.map((column) => (
                  <td key={`${rowIndex}_${column.key}`}>
                    {typeof column.render === 'function'
                      ? column.render(row[column.key], row)
                      : String(row[column.key] ?? '-')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="app">
      <div className="topbar">
        <div className="title-block">
          <h1>Whitehall CS-Cart Admin</h1>
          <p>
            React UI для пайплайна CS-Cart: перенос legacy flow, модульна адмінка, без зміни
            бізнес-логіки backend.
          </p>
        </div>
        <div className="top-actions">
          <Tag tone={apiStatus === 'ok' ? 'ok' : 'error'}>API: {apiStatus}</Tag>
          <Tag tone={readyForImport ? 'ok' : 'warn'}>
            store import: {readyForImport ? 'ready' : 'check gates'}
          </Tag>
          {lastFailedAction ? (
            <button className="btn danger" disabled={isReadOnly} onClick={retryLastFailedAction}>
              Retry failed: {lastFailedAction.label}
            </button>
          ) : null}
          <button className="btn" onClick={refreshCore}>Оновити</button>
          <button className="btn danger" onClick={logout}>Logout</button>
        </div>
      </div>

      {topStatus ? <div className="top-status">{topStatus}</div> : null}

      <div className="tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={`tab ${tab === item.id ? 'active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <div className="grid">
          <Section title="Readiness" subtitle="Поточні backend-гейти перед store import">
            <pre>{toJsonString(readiness || {})}</pre>
          </Section>

          <Section title="Stats" subtitle="Операційна статистика">
            <pre>{toJsonString(stats || {})}</pre>
          </Section>

          <Section title="Операційні сигнали" subtitle="Ключові KPI та останні error-логи">
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Suppliers</div>
                <div className="kpi-value">{Number(stats?.suppliers || 0)}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Sources</div>
                <div className="kpi-value">{Number(stats?.sources || 0)}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Raw rows</div>
                <div className="kpi-value">{Number(stats?.products_raw || 0)}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Final rows</div>
                <div className="kpi-value">{Number(stats?.products_final || 0)}</div>
              </div>
            </div>
            <div className="status-line">
              Running jobs: {(readiness?.jobs?.running_blocking_jobs || []).length}
            </div>
            <div className="status-line">
              Mirror fresh: {readiness?.mirror?.is_fresh ? 'yes' : 'no'}
            </div>
            <div className="status-line">Recent errors: {recentErrorLogs.length}</div>
            {recentErrorLogs.length > 0 ? (
              <div className="preview-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>time</th>
                      <th>job</th>
                      <th>message</th>
                      <th>action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentErrorLogs.map((item) => (
                      <tr key={item.id}>
                        <td>{item.created_at || '-'}</td>
                        <td>{item.job_id || '-'}</td>
                        <td>{item.message || '-'}</td>
                        <td>
                          {item.job_id ? (
                            <button className="btn" onClick={() => openJobDetails(item.job_id)}>
                              Job details
                            </button>
                          ) : (
                            '-'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-preview">Error logs не знайдено за поточним фільтром</div>
            )}
          </Section>

          <Section title="Швидкі дії" subtitle="Запуск джоб без переходу по екранах">
            <div className="form-row">
              <div>
                <label>sourceId</label>
                <input
                  value={actionForm.sourceId}
                  onChange={(event) =>
                    setActionForm((prev) => ({ ...prev, sourceId: event.target.value }))
                  }
                />
              </div>
              <div>
                <label>supplierId</label>
                <input
                  value={actionForm.supplierId}
                  onChange={(event) =>
                    setActionForm((prev) => ({ ...prev, supplierId: event.target.value }))
                  }
                />
              </div>
              <div>
                <label>store supplier (optional)</label>
                <input
                  value={actionForm.storeSupplier}
                  onChange={(event) =>
                    setActionForm((prev) => ({ ...prev, storeSupplier: event.target.value }))
                  }
                />
              </div>
            </div>

            <div className="form-row">
              <div>
                <label>resumeFromJobId (optional)</label>
                <input
                  value={actionForm.resumeFromJobId}
                  onChange={(event) =>
                    setActionForm((prev) => ({ ...prev, resumeFromJobId: event.target.value }))
                  }
                />
              </div>
              <div>
                <label>retentionDays</label>
                <input
                  value={actionForm.retentionDays}
                  onChange={(event) =>
                    setActionForm((prev) => ({ ...prev, retentionDays: event.target.value }))
                  }
                />
              </div>
              <div>
                <label>update pipeline supplier (optional)</label>
                <input
                  value={actionForm.updatePipelineSupplier}
                  onChange={(event) =>
                    setActionForm((prev) => ({
                      ...prev,
                      updatePipelineSupplier: event.target.value
                    }))
                  }
                />
              </div>
            </div>

            <div className="actions">
              <button
                className="btn"
                disabled={isReadOnly}
                onClick={() => runJob('import_all', '/jobs/import-all')}
              >
                import_all
              </button>
              <button
                className="btn"
                disabled={isReadOnly || !Number.isFinite(Number(actionForm.sourceId))}
                onClick={() =>
                  runJob('import_source', '/jobs/import-source', {
                    sourceId: Number(actionForm.sourceId)
                  })
                }
              >
                import_source
              </button>
              <button
                className="btn"
                disabled={isReadOnly || !Number.isFinite(Number(actionForm.supplierId))}
                onClick={() =>
                  runJob('import_supplier', '/jobs/import-supplier', {
                    supplierId: Number(actionForm.supplierId)
                  })
                }
              >
                import_supplier
              </button>
              <button className="btn" disabled={isReadOnly} onClick={() => runJob('finalize', '/jobs/finalize')}>
                finalize
              </button>
              <button className="btn" disabled={isReadOnly} onClick={() => runJob('store_mirror_sync', '/jobs/store-mirror-sync')}>
                mirror_sync
              </button>
              <button className="btn primary" disabled={isReadOnly} onClick={runStoreImport}>
                store_import
              </button>
              <button
                className="btn"
                disabled={isReadOnly}
                onClick={() =>
                  runJob('update_pipeline', '/jobs/update-pipeline', {
                    supplier: actionForm.updatePipelineSupplier.trim() || undefined
                  })
                }
              >
                update_pipeline
              </button>
              <button
                className="btn"
                disabled={isReadOnly || !Number.isFinite(Number(actionForm.retentionDays))}
                onClick={runCleanupWithPreflight}
              >
                cleanup
              </button>
            </div>

            <div className="preflight-warning">
              Preflight: `cleanup` вимагає keyword-підтвердження перед запуском.
            </div>

            <label style={{ marginTop: 10 }}>
              <input
                type="checkbox"
                checked={actionForm.resumeLatest}
                onChange={(event) =>
                  setActionForm((prev) => ({ ...prev, resumeLatest: event.target.checked }))
                }
                style={{ width: 'auto', marginRight: 8 }}
              />
              Resume latest failed/canceled store_import
            </label>

            <div className={`status-line ${actionStatus.includes('Error') ? 'error' : ''}`}>{actionStatus}</div>
          </Section>
        </div>
      ) : null}

      {tab === 'suppliers' ? (
        <div className="grid">
          <Section title="Постачальники" subtitle="Пошук, сортування, CRUD" extra={
            <button className="btn" onClick={refreshSuppliers}>Оновити список</button>
          }>
            <div className="form-row">
              <div>
                <label>Пошук</label>
                <input value={supplierSearch} onChange={(event) => setSupplierSearch(event.target.value)} />
              </div>
              <div>
                <label>Сортування</label>
                <select value={supplierSort} onChange={(event) => setSupplierSort(event.target.value)}>
                  <option value="id_asc">ID</option>
                  <option value="name_asc">A-Я</option>
                  <option value="name_desc">Я-A</option>
                </select>
              </div>
              <div>
                <label>Selected IDs</label>
                <input value={selectedSupplierIds.join(',')} readOnly />
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Select</th>
                  <th>ID</th>
                  <th>Назва</th>
                  <th>Active</th>
                  <th>Priority</th>
                  <th>Markup %</th>
                  <th>Rule set</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((supplier) => (
                  <tr key={supplier.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedSupplierIds.includes(String(supplier.id))}
                        onChange={(event) => {
                          setSelectedSupplierIds((prev) => {
                            const id = String(supplier.id);
                            if (event.target.checked) {
                              return prev.includes(id) ? prev : [...prev, id];
                            }
                            return prev.filter((value) => value !== id);
                          });
                        }}
                      />
                    </td>
                    <td>{supplier.id}</td>
                    <td>{supplier.name}</td>
                    <td>{supplier.is_active ? 'true' : 'false'}</td>
                    <td>{supplier.priority}</td>
                    <td>{supplier.markup_percent}</td>
                    <td>{supplier.markup_rule_set_name || '-'}</td>
                    <td>
                      <div className="actions">
                        <button
                          className="btn"
                          onClick={() => {
                            setEditingSupplierId(String(supplier.id));
                            setSupplierDraft(toSupplierDraft(supplier));
                            setSupplierErrors({});
                            setSelectedSupplierId(String(supplier.id));
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="btn danger"
                          disabled={isReadOnly}
                          onClick={() => deleteSupplier(supplier.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="status-line">{suppliersStatus}</div>
          </Section>

          <Section title={editingSupplierId ? `Редагування #${editingSupplierId}` : 'Новий постачальник'}>
            <div className="form-row">
              <div>
                <label>Назва</label>
                <input
                  value={supplierDraft.name}
                  onChange={(event) =>
                    setSupplierDraft((prev) => ({ ...prev, name: event.target.value }))
                  }
                />
                {supplierErrors.name ? <div className="field-error">{supplierErrors.name}</div> : null}
              </div>
              <div>
                <label>Priority</label>
                <input
                  value={supplierDraft.priority}
                  onChange={(event) =>
                    setSupplierDraft((prev) => ({ ...prev, priority: event.target.value }))
                  }
                />
                {supplierErrors.priority ? <div className="field-error">{supplierErrors.priority}</div> : null}
              </div>
              <div>
                <label>Markup %</label>
                <input
                  value={supplierDraft.markup_percent}
                  onChange={(event) =>
                    setSupplierDraft((prev) => ({ ...prev, markup_percent: event.target.value }))
                  }
                />
                {supplierErrors.markup_percent ? <div className="field-error">{supplierErrors.markup_percent}</div> : null}
              </div>
            </div>
            <div className="form-row">
              <div>
                <label>Min profit amount</label>
                <input
                  value={supplierDraft.min_profit_amount}
                  onChange={(event) =>
                    setSupplierDraft((prev) => ({ ...prev, min_profit_amount: event.target.value }))
                  }
                />
                {supplierErrors.min_profit_amount ? <div className="field-error">{supplierErrors.min_profit_amount}</div> : null}
              </div>
              <div>
                <label>Markup rule set id</label>
                <input
                  value={supplierDraft.markup_rule_set_id}
                  onChange={(event) =>
                    setSupplierDraft((prev) => ({ ...prev, markup_rule_set_id: event.target.value }))
                  }
                />
                {supplierErrors.markup_rule_set_id ? <div className="field-error">{supplierErrors.markup_rule_set_id}</div> : null}
              </div>
            </div>
            <div className="checkbox-row">
              <label>
                <input
                  type="checkbox"
                  checked={supplierDraft.min_profit_enabled}
                  onChange={(event) =>
                    setSupplierDraft((prev) => ({ ...prev, min_profit_enabled: event.target.checked }))
                  }
                />
                min_profit_enabled
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={supplierDraft.is_active}
                  onChange={(event) =>
                    setSupplierDraft((prev) => ({ ...prev, is_active: event.target.checked }))
                  }
                />
                is_active
              </label>
            </div>
            <div className="actions" style={{ marginTop: 8 }}>
              <button className="btn primary" disabled={isReadOnly} onClick={saveSupplier}>
                {editingSupplierId ? 'Save supplier' : 'Create supplier'}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setEditingSupplierId('');
                  setSupplierDraft(toSupplierDraft(null));
                  setSupplierErrors({});
                }}
              >
                Reset form
              </button>
            </div>
            <div className="status-line">{supplierFormStatus}</div>
          </Section>

          <Section title="Bulk update suppliers" subtitle="Без зміни бізнес-логіки, лише масове оновлення полів">
            <div className="form-row">
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={bulkDraft.apply_markup_percent}
                    onChange={(event) =>
                      setBulkDraft((prev) => ({ ...prev, apply_markup_percent: event.target.checked }))
                    }
                    style={{ width: 'auto', marginRight: 8 }}
                  />
                  Apply markup_percent
                </label>
                <input
                  value={bulkDraft.markup_percent}
                  onChange={(event) =>
                    setBulkDraft((prev) => ({ ...prev, markup_percent: event.target.value }))
                  }
                />
              </div>
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={bulkDraft.apply_min_profit}
                    onChange={(event) =>
                      setBulkDraft((prev) => ({ ...prev, apply_min_profit: event.target.checked }))
                    }
                    style={{ width: 'auto', marginRight: 8 }}
                  />
                  Apply min_profit
                </label>
                <input
                  value={bulkDraft.min_profit_amount}
                  onChange={(event) =>
                    setBulkDraft((prev) => ({ ...prev, min_profit_amount: event.target.value }))
                  }
                />
              </div>
            </div>
            <label style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={bulkDraft.min_profit_enabled}
                onChange={(event) =>
                  setBulkDraft((prev) => ({ ...prev, min_profit_enabled: event.target.checked }))
                }
                style={{ width: 'auto', marginRight: 8 }}
              />
              min_profit_enabled
            </label>
            <div className="actions" style={{ marginTop: 8 }}>
              <button className="btn primary" disabled={isReadOnly} onClick={saveSupplierBulk}>
                Run bulk update
              </button>
              <button className="btn" onClick={() => setSelectedSupplierIds([])}>
                Clear selection
              </button>
            </div>
            <div className="status-line">{bulkStatus}</div>
          </Section>
        </div>
      ) : null}

      {tab === 'mapping' ? (
        <div className="grid">
          <Section title="Джерела" subtitle="Source CRUD + sheet preview">
            <div className="form-row">
              <div>
                <label>Постачальник</label>
                <select
                  value={selectedSupplierId}
                  onChange={(event) => setSelectedSupplierId(event.target.value)}
                >
                  <option value="">-- оберіть --</option>
                  {suppliers.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.id} - {supplier.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Джерело</label>
                <select
                  value={selectedSourceId}
                  onChange={(event) => setSelectedSourceId(event.target.value)}
                >
                  <option value="">-- оберіть --</option>
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.id} - {source.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>&nbsp;</label>
                <button className="btn" onClick={() => refreshSources(selectedSupplierId)}>
                  Оновити джерела
                </button>
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Active</th>
                  <th>Sheet</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id}>
                    <td>{source.id}</td>
                    <td>{source.name}</td>
                    <td>{source.source_type}</td>
                    <td>{source.is_active ? 'true' : 'false'}</td>
                    <td>{source.sheet_name || '-'}</td>
                    <td>
                      <div className="actions">
                        <button
                          className="btn"
                          onClick={() => {
                            setEditingSourceId(String(source.id));
                            setSelectedSourceId(String(source.id));
                            setSourceDraft(toSourceDraft(source));
                            setSourceErrors({});
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="btn danger"
                          disabled={isReadOnly}
                          onClick={() => deleteSource(source.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="status-line">{sourcesStatus}</div>
          </Section>

          <Section title={editingSourceId ? `Редагування source #${editingSourceId}` : 'Нове джерело'}>
            <div className="form-row">
              <div>
                <label>Name</label>
                <input
                  value={sourceDraft.name}
                  onChange={(event) =>
                    setSourceDraft((prev) => ({ ...prev, name: event.target.value }))
                  }
                />
              </div>
              <div>
                <label>source_type</label>
                <select
                  value={sourceDraft.source_type}
                  onChange={(event) =>
                    setSourceDraft((prev) => ({ ...prev, source_type: event.target.value }))
                  }
                >
                  {SOURCE_TYPES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
                {sourceErrors.source_type ? <div className="field-error">{sourceErrors.source_type}</div> : null}
              </div>
            </div>
            <div className="form-row">
              <div>
                <label>source_url</label>
                <input
                  value={sourceDraft.source_url}
                  onChange={(event) =>
                    setSourceDraft((prev) => ({ ...prev, source_url: event.target.value }))
                  }
                />
                {sourceErrors.source_url ? <div className="field-error">{sourceErrors.source_url}</div> : null}
                <div className="hint">detected: {parseSourceUrlHint(sourceDraft.source_url) || '-'}</div>
              </div>
              <div>
                <label>sheet_name</label>
                <input
                  value={sourceDraft.sheet_name}
                  onChange={(event) =>
                    setSourceDraft((prev) => ({ ...prev, sheet_name: event.target.value }))
                  }
                />
              </div>
            </div>
            <label>
              <input
                type="checkbox"
                checked={sourceDraft.is_active}
                onChange={(event) =>
                  setSourceDraft((prev) => ({ ...prev, is_active: event.target.checked }))
                }
                style={{ width: 'auto', marginRight: 8 }}
              />
              is_active
            </label>
            <div className="actions" style={{ marginTop: 8 }}>
              <button className="btn primary" disabled={isReadOnly} onClick={saveSource}>
                {editingSourceId ? 'Save source' : 'Create source'}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setEditingSourceId('');
                  setSourceDraft(toSourceDraft(null));
                  setSourceErrors({});
                }}
              >
                Reset form
              </button>
            </div>
            <div className="status-line">{sourceFormStatus}</div>
          </Section>

          <Section title="Google Sheets preview" subtitle="Лоад аркушів + headers/sample rows">
            <div className="form-row">
              <div>
                <label>Sheet name</label>
                <select
                  value={selectedSheetName}
                  onChange={(event) => setSelectedSheetName(event.target.value)}
                >
                  <option value="">-- auto --</option>
                  {sourceSheets.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Header row</label>
                <input
                  value={mappingHeaderRow}
                  onChange={(event) => setMappingHeaderRow(event.target.value)}
                />
              </div>
            </div>
            <div className="actions">
              <button className="btn" onClick={loadSourceSheets}>Load sheets</button>
              <button className="btn" onClick={loadSourcePreview}>Load preview</button>
            </div>
            <div className="status-line">{sourceSheetsStatus}</div>
            <div className={`status-line ${sourcePreview.status.includes('error') ? 'error' : ''}`}>
              {sourcePreview.status}
            </div>
            <pre>{toJsonString({
              sheet: sourcePreview.sheetName || selectedSheetName || null,
              headerRow: sourcePreview.headerRow,
              headers: sourcePreview.headers
            })}</pre>
            {sourcePreview.sampleRows.length > 0 ? (
              <div className="preview-table-wrap">
                <table>
                  <thead>
                    <tr>
                      {sourcePreview.headers.map((header, index) => (
                        <th key={index}>
                          {columnLetter(index + 1)} / {index + 1}
                          <br />
                          {header || '[blank]'}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sourcePreview.sampleRows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {sourcePreview.headers.map((_, colIndex) => (
                          <td key={`${rowIndex}_${colIndex}`}>{row[colIndex] || ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Section>

          <Section title="Мапінг" subtitle="Builder + JSON + Коментар">
            <div className="mapping-builder">
              {MAPPING_KEYS.map((key) => {
                const entry = mappingFields[key];
                return (
                  <div className="mapping-row" key={key}>
                    <div className="mapping-key">{key}</div>
                    <select
                      value={entry.mode}
                      onChange={(event) => {
                        const mode = event.target.value;
                        if (mode === 'static') {
                          updateMappingField(key, {
                            mode: 'static',
                            value: entry.value === null ? '' : String(entry.value)
                          });
                        } else {
                          updateMappingField(key, {
                            mode: 'column',
                            value:
                              Number.isFinite(Number(entry.value)) && Number(entry.value) > 0
                                ? Number(entry.value)
                                : null
                          });
                        }
                      }}
                    >
                      <option value="column">column</option>
                      <option value="static">static</option>
                    </select>
                    {entry.mode === 'column' ? (
                      <select
                        value={entry.value === null ? '' : String(entry.value)}
                        onChange={(event) =>
                          updateMappingField(key, {
                            value: event.target.value ? Number(event.target.value) : null
                          })
                        }
                      >
                        <option value="">-- not set --</option>
                        {mappingColumnOptions.map((option) => (
                          <option key={`${key}_${option.value}`} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={String(entry.value ?? '')}
                        onChange={(event) =>
                          updateMappingField(key, {
                            value: event.target.value
                          })
                        }
                      />
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={entry.allowEmpty === true}
                        onChange={(event) =>
                          updateMappingField(key, { allowEmpty: event.target.checked })
                        }
                        style={{ width: 'auto', marginRight: 6 }}
                      />
                      allow empty
                    </label>
                  </div>
                );
              })}
            </div>

            <div className="actions" style={{ marginTop: 8 }}>
              <button className="btn" onClick={applyBuilderToJson}>
                Builder to JSON
              </button>
              <button className="btn" onClick={() => refreshMapping(selectedSupplierId, selectedSourceId)}>
                Reload mapping
              </button>
            </div>

            <div className="form-row">
              <div>
                <label>Header row</label>
                <input
                  value={mappingHeaderRow}
                  onChange={(event) => setMappingHeaderRow(event.target.value)}
                />
                {mappingErrors.header_row ? <div className="field-error">{mappingErrors.header_row}</div> : null}
              </div>
              <div>
                <label>Коментар</label>
                <input
                  value={mappingComment}
                  onChange={(event) => setMappingComment(event.target.value)}
                />
              </div>
            </div>
            <label>Mapping JSON</label>
            <textarea value={mappingText} onChange={(event) => setMappingText(event.target.value)} />
            {mappingErrors.mapping ? <div className="field-error">{mappingErrors.mapping}</div> : null}
            <div className="actions" style={{ marginTop: 8 }}>
              <button className="btn primary" disabled={isReadOnly} onClick={saveMapping}>
                Save mapping
              </button>
            </div>
            <div className={`status-line ${mappingStatus.includes('помилка') || mappingStatus.includes('error') ? 'error' : ''}`}>
              {mappingStatus}
            </div>
          </Section>
        </div>
      ) : null}

      {tab === 'pricing' ? (
        <div className="grid">
          <Section
            title="Markup Rule Sets"
            subtitle="Огляд, default, apply по suppliers/all suppliers"
            extra={<button className="btn" onClick={refreshMarkupRuleSets}>Reload</button>}
          >
            <div className="form-row">
              <div>
                <label>Rule set</label>
                <select
                  value={pricingApplyRuleSetId}
                  onChange={(event) => setPricingApplyRuleSetId(event.target.value)}
                >
                  <option value="">-- оберіть --</option>
                  {markupRuleSets.map((ruleSet) => (
                    <option key={ruleSet.id} value={ruleSet.id}>
                      #{ruleSet.id} {ruleSet.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Scope</label>
                <select
                  value={pricingApplyScope}
                  onChange={(event) => setPricingApplyScope(event.target.value)}
                >
                  <option value="suppliers">suppliers (selected)</option>
                  <option value="all_suppliers">all_suppliers</option>
                </select>
              </div>
              <div>
                <label>&nbsp;</label>
                <div className="actions">
                  <button className="btn" disabled={isReadOnly} onClick={applyMarkupRuleSet}>Apply</button>
                  <button
                    className="btn"
                    disabled={isReadOnly || !pricingApplyRuleSetId}
                    onClick={() => setDefaultMarkupRuleSet(pricingApplyRuleSetId)}
                  >
                    Set default
                  </button>
                  <button className="btn" onClick={startCreateRuleSet}>New rule set</button>
                </div>
              </div>
            </div>
            <div className="status-line">global_rule_set_id: {globalRuleSetId || '-'}</div>
            {pricingApplyScope === 'all_suppliers' ? (
              <div className="preflight-warning">
                Scope `all_suppliers` запускає preflight keyword-підтвердження.
              </div>
            ) : null}
            <div className="status-line">{pricingStatus}</div>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Active</th>
                  <th>Conditions</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {markupRuleSets.map((ruleSet) => (
                  <tr key={ruleSet.id}>
                    <td>{ruleSet.id}</td>
                    <td>
                      {ruleSet.name}
                      {Number(globalRuleSetId || 0) === Number(ruleSet.id) ? (
                        <span className="chip">default</span>
                      ) : null}
                    </td>
                    <td>{ruleSet.is_active ? 'true' : 'false'}</td>
                    <td>
                      {Array.isArray(ruleSet.conditions) ? ruleSet.conditions.length : 0}
                    </td>
                    <td>
                      <div className="actions">
                        <button className="btn" onClick={() => startEditRuleSet(ruleSet.id)}>
                          Edit in form
                        </button>
                        <button
                          className="btn"
                          onClick={() => setPricingApplyRuleSetId(String(ruleSet.id))}
                        >
                          Select
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            title={ruleSetDraft.id ? `Rule Set #${ruleSetDraft.id}` : 'Створення Rule Set'}
            subtitle="Повний editor conditions для create/update"
          >
            <div className="form-row">
              <div>
                <label>Name</label>
                <input
                  value={ruleSetDraft.name}
                  onChange={(event) =>
                    setRuleSetDraft((prev) => ({ ...prev, name: event.target.value }))
                  }
                />
                {ruleSetErrors.base ? <div className="field-error">{ruleSetErrors.base}</div> : null}
              </div>
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={ruleSetDraft.is_active}
                    onChange={(event) =>
                      setRuleSetDraft((prev) => ({ ...prev, is_active: event.target.checked }))
                    }
                    style={{ width: 'auto', marginRight: 8 }}
                  />
                  is_active
                </label>
              </div>
            </div>

            <div className="conditions-list">
              {ruleSetDraft.conditions.map((condition, index) => (
                <div className="condition-card" key={`condition_${index}`}>
                  <div className="condition-title">Condition #{index + 1}</div>
                  {ruleSetErrors[`condition_${index}`] ? (
                    <div className="field-error">{ruleSetErrors[`condition_${index}`]}</div>
                  ) : null}
                  <div className="form-row">
                    <div>
                      <label>priority</label>
                      <input
                        value={condition.priority}
                        onChange={(event) =>
                          updateRuleCondition(index, { priority: event.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label>price_from</label>
                      <input
                        value={condition.price_from}
                        onChange={(event) =>
                          updateRuleCondition(index, { price_from: event.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label>price_to (optional)</label>
                      <input
                        value={condition.price_to}
                        onChange={(event) =>
                          updateRuleCondition(index, { price_to: event.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label>action_type</label>
                      <select
                        value={condition.action_type}
                        onChange={(event) =>
                          updateRuleCondition(index, { action_type: event.target.value })
                        }
                      >
                        <option value="percent">percent</option>
                        <option value="fixed_add">fixed_add</option>
                      </select>
                    </div>
                    <div>
                      <label>action_value</label>
                      <input
                        value={condition.action_value}
                        onChange={(event) =>
                          updateRuleCondition(index, { action_value: event.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div className="actions">
                    <label>
                      <input
                        type="checkbox"
                        checked={condition.is_active}
                        onChange={(event) =>
                          updateRuleCondition(index, { is_active: event.target.checked })
                        }
                        style={{ width: 'auto', marginRight: 8 }}
                      />
                      is_active
                    </label>
                    <button
                      className="btn danger"
                      disabled={ruleSetDraft.conditions.length <= 1}
                      onClick={() => removeRuleCondition(index)}
                    >
                      Remove condition
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="actions" style={{ marginTop: 10 }}>
              <button className="btn" onClick={addRuleCondition}>Add condition</button>
              <button className="btn primary" disabled={isReadOnly} onClick={saveRuleSet}>
                {ruleSetDraft.id ? 'Update rule set' : 'Create rule set'}
              </button>
              <button className="btn" onClick={startCreateRuleSet}>Reset editor</button>
            </div>
            <div className={`status-line ${ruleSetStatus.includes('invalid') ? 'error' : ''}`}>
              {ruleSetStatus}
            </div>
          </Section>

          <Section title="Price Overrides" subtitle="Upsert/update для фінальної ціни">
            <div className="form-row">
              <div>
                <label>search</label>
                <input
                  value={priceOverrideFilters.search}
                  onChange={(event) =>
                    setPriceOverrideFilters((prev) => ({ ...prev, search: event.target.value }))
                  }
                />
              </div>
              <div>
                <label>limit</label>
                <input
                  value={priceOverrideFilters.limit}
                  onChange={(event) =>
                    setPriceOverrideFilters((prev) => ({ ...prev, limit: event.target.value }))
                  }
                />
              </div>
              <div>
                <label>offset</label>
                <input
                  value={priceOverrideFilters.offset}
                  onChange={(event) =>
                    setPriceOverrideFilters((prev) => ({ ...prev, offset: event.target.value }))
                  }
                />
              </div>
            </div>
            <div className="actions">
              <button className="btn" onClick={refreshPriceOverrides}>Reload overrides</button>
            </div>

            <div className="form-row" style={{ marginTop: 10 }}>
              <div>
                <label>article</label>
                <input
                  value={priceOverrideDraft.article}
                  onChange={(event) =>
                    setPriceOverrideDraft((prev) => ({ ...prev, article: event.target.value }))
                  }
                  disabled={Boolean(priceOverrideDraft.id)}
                />
                {priceOverrideErrors.article ? <div className="field-error">{priceOverrideErrors.article}</div> : null}
              </div>
              <div>
                <label>size</label>
                <input
                  value={priceOverrideDraft.size}
                  onChange={(event) =>
                    setPriceOverrideDraft((prev) => ({ ...prev, size: event.target.value }))
                  }
                  disabled={Boolean(priceOverrideDraft.id)}
                />
              </div>
              <div>
                <label>price_final</label>
                <input
                  value={priceOverrideDraft.price_final}
                  onChange={(event) =>
                    setPriceOverrideDraft((prev) => ({ ...prev, price_final: event.target.value }))
                  }
                />
                {priceOverrideErrors.price_final ? <div className="field-error">{priceOverrideErrors.price_final}</div> : null}
              </div>
            </div>
            <div className="form-row">
              <div>
                <label>notes</label>
                <input
                  value={priceOverrideDraft.notes}
                  onChange={(event) =>
                    setPriceOverrideDraft((prev) => ({ ...prev, notes: event.target.value }))
                  }
                />
              </div>
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={priceOverrideDraft.is_active}
                    onChange={(event) =>
                      setPriceOverrideDraft((prev) => ({ ...prev, is_active: event.target.checked }))
                    }
                    style={{ width: 'auto', marginRight: 8 }}
                  />
                  is_active
                </label>
              </div>
            </div>
            <div className="actions">
              <button className="btn primary" disabled={isReadOnly} onClick={savePriceOverride}>
                {priceOverrideDraft.id ? 'Update override' : 'Upsert override'}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setPriceOverrideDraft(toPriceOverrideDraft(null));
                  setPriceOverrideErrors({});
                }}
              >
                Reset override form
              </button>
            </div>

            <div className="status-line">{priceOverrideStatus}</div>
            <div className="status-line">{priceOverrides.status}</div>

            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Article</th>
                  <th>Size</th>
                  <th>Price final</th>
                  <th>Active</th>
                  <th>Notes</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {priceOverrides.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    <td>{row.article}</td>
                    <td>{row.size || '-'}</td>
                    <td>{row.price_final}</td>
                    <td>{row.is_active ? 'true' : 'false'}</td>
                    <td>{row.notes || '-'}</td>
                    <td>
                      <button
                        className="btn"
                        onClick={() => {
                          setPriceOverrideDraft(toPriceOverrideDraft(row));
                          setPriceOverrideErrors({});
                        }}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </div>
      ) : null}

      {tab === 'data' ? (
        <div className="data-grid">
          <Section title="Фільтри" subtitle="Параметри серверної вибірки та сортування">
            <div className="form-row">
              <div>
                <label>limit</label>
                <input
                  value={dataFilters.limit}
                  onChange={(event) => setDataFilters((prev) => ({ ...prev, limit: event.target.value }))}
                />
              </div>
              <div>
                <label>offset</label>
                <input
                  value={dataFilters.offset}
                  onChange={(event) => setDataFilters((prev) => ({ ...prev, offset: event.target.value }))}
                />
              </div>
              <div>
                <label>search</label>
                <input
                  value={dataFilters.search}
                  onChange={(event) => setDataFilters((prev) => ({ ...prev, search: event.target.value }))}
                />
              </div>
              <div>
                <label>supplierId (final/compare)</label>
                <input
                  value={dataFilters.supplierId}
                  onChange={(event) => setDataFilters((prev) => ({ ...prev, supplierId: event.target.value }))}
                />
              </div>
            </div>
            <div className="form-row">
              <div>
                <label>Merged sort</label>
                <select
                  value={dataFilters.mergedSort}
                  onChange={(event) =>
                    setDataFilters((prev) => ({ ...prev, mergedSort: event.target.value }))
                  }
                >
                  <option value="article_asc">article asc</option>
                  <option value="article_desc">article desc</option>
                  <option value="created_desc">created desc</option>
                </select>
              </div>
              <div>
                <label>Final sort</label>
                <select
                  value={dataFilters.finalSort}
                  onChange={(event) =>
                    setDataFilters((prev) => ({ ...prev, finalSort: event.target.value }))
                  }
                >
                  <option value="article_asc">article asc</option>
                  <option value="article_desc">article desc</option>
                  <option value="created_desc">created desc</option>
                </select>
              </div>
            </div>
            <div className="actions">
              <label>
                <input
                  type="checkbox"
                  checked={dataFilters.missingOnly}
                  onChange={(event) =>
                    setDataFilters((prev) => ({ ...prev, missingOnly: event.target.checked }))
                  }
                  style={{ width: 'auto', marginRight: 8 }}
                />
                compare missingOnly
              </label>
              <button
                className="btn"
                onClick={() => {
                  if (activeDataView === 'merged') {
                    void loadMerged();
                  } else if (activeDataView === 'final') {
                    void loadFinal();
                  } else {
                    void loadCompare();
                  }
                }}
              >
                Load active view
              </button>
              <button
                className="btn"
                onClick={() => {
                  void loadMerged();
                  void loadFinal();
                  void loadCompare();
                }}
              >
                Load all
              </button>
              <button className="btn" onClick={() => shiftDataOffset(-1)}>Prev page</button>
              <button className="btn" onClick={() => shiftDataOffset(1)}>Next page</button>
            </div>
          </Section>

          <div className="mini-tabs">
            <button
              className={`tab ${activeDataView === 'merged' ? 'active' : ''}`}
              onClick={() => setActiveDataView('merged')}
            >
              merged
            </button>
            <button
              className={`tab ${activeDataView === 'final' ? 'active' : ''}`}
              onClick={() => setActiveDataView('final')}
            >
              final
            </button>
            <button
              className={`tab ${activeDataView === 'compare' ? 'active' : ''}`}
              onClick={() => setActiveDataView('compare')}
            >
              compare
            </button>
          </div>

          {activeDataView === 'merged' ? (
            <Section title="Merged preview" extra={<button className="btn" onClick={loadMerged}>Load</button>}>
              <div className="actions" style={{ marginBottom: 8 }}>
                <a className="btn" href="/admin/api/merged-export">Export CSV</a>
                <span className="chip">total: {mergedState.total}</span>
                <span className="chip">offset: {dataFilters.offset}</span>
              </div>
              <div className="status-line">{mergedState.status}</div>
              {renderPreviewTable(
                mergedState.rows,
                [
                  { key: 'article', label: 'article' },
                  { key: 'size', label: 'size' },
                  { key: 'quantity', label: 'qty' },
                  { key: 'price', label: 'price' },
                  { key: 'supplier_name', label: 'supplier' },
                  { key: 'extra', label: 'extra' }
                ],
                'Merged preview is empty'
              )}
            </Section>
          ) : null}

          {activeDataView === 'final' ? (
            <Section title="Final preview" extra={<button className="btn" onClick={loadFinal}>Load</button>}>
              <div className="actions" style={{ marginBottom: 8 }}>
                <a className="btn" href="/admin/api/final-export">Export CSV</a>
                <span className="chip">total: {finalState.total}</span>
                <span className="chip">offset: {dataFilters.offset}</span>
              </div>
              <div className="status-line">{finalState.status}</div>
              {renderPreviewTable(
                finalState.rows,
                [
                  { key: 'article', label: 'article' },
                  { key: 'size', label: 'size' },
                  { key: 'quantity', label: 'qty' },
                  { key: 'price_base', label: 'base' },
                  { key: 'price_final', label: 'final' },
                  { key: 'supplier_name', label: 'supplier' }
                ],
                'Final preview is empty'
              )}
            </Section>
          ) : null}

          {activeDataView === 'compare' ? (
            <Section title="Compare preview (CS-Cart)" extra={<button className="btn" onClick={loadCompare}>Load</button>}>
              <div className="actions" style={{ marginBottom: 8 }}>
                <a className="btn" href="/admin/api/compare-export?store=cscart">Export CSV</a>
                <span className="chip">total: {compareState.total}</span>
                <span className="chip">offset: {dataFilters.offset}</span>
              </div>
              <div className="status-line">{compareState.status}</div>
              {renderPreviewTable(
                compareState.rows,
                [
                  { key: 'article', label: 'article' },
                  { key: 'size', label: 'size' },
                  { key: 'price_final', label: 'final' },
                  { key: 'sku_article', label: 'sku_article' },
                  { key: 'store_sku', label: 'store_sku' },
                  { key: 'store_visibility', label: 'visibility' }
                ],
                'Compare preview is empty'
              )}
            </Section>
          ) : null}
        </div>
      ) : null}

      {tab === 'jobs' ? (
        <div className="grid">
          <Section
            title="Jobs"
            extra={<button className="btn" onClick={refreshCore}>Reload</button>}
          >
            <div className="status-line">{jobsStatus}</div>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{job.id}</td>
                    <td>{job.type}</td>
                    <td>{job.status}</td>
                    <td>{job.created_at || '-'}</td>
                    <td>
                      <div className="actions">
                        <button className="btn" onClick={() => openJobDetails(job.id)}>
                          Details
                        </button>
                        {job.status === 'running' || job.status === 'queued' ? (
                          <button className="btn danger" disabled={isReadOnly} onClick={() => cancelJob(job.id)}>
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            title="Logs"
            subtitle="Операційний потік помилок і попереджень"
            extra={
              <div className="actions">
                <select value={logsLevel} onChange={(event) => setLogsLevel(event.target.value)}>
                  <option value="">all</option>
                  <option value="error">error</option>
                  <option value="warning">warning</option>
                  <option value="info">info</option>
                </select>
                <input
                  value={logsJobId}
                  onChange={(event) => setLogsJobId(event.target.value)}
                  placeholder="jobId"
                  style={{ width: 110 }}
                />
                <button className="btn" onClick={refreshCore}>Reload</button>
                <button
                  className="btn"
                  onClick={() => {
                    setLogsLevel('');
                    setLogsJobId('');
                    void refreshCore();
                  }}
                >
                  Reset
                </button>
              </div>
            }
          >
            <pre>{toJsonString(logs.slice(0, 120))}</pre>
          </Section>

          {jobDetails.jobId ? (
            <Section
              title={`Job details #${jobDetails.jobId}`}
              extra={
                <div className="actions">
                  <button
                    className="btn"
                    onClick={() => {
                      if (jobDetails.jobId) {
                        void openJobDetails(jobDetails.jobId);
                      }
                    }}
                  >
                    Reload details
                  </button>
                  <button className="btn" onClick={closeJobDetails}>Close</button>
                </div>
              }
            >
              {jobDetails.loading ? <div className="status-line">Loading...</div> : null}
              {jobDetails.error ? <div className="status-line error">{jobDetails.error}</div> : null}
              {jobDetails.payload ? (
                <div className="grid">
                  <div>
                    <h4 className="block-title">Job</h4>
                    <pre>{toJsonString(jobDetails.payload.job || {})}</pre>
                  </div>
                  <div>
                    <h4 className="block-title">Children</h4>
                    <pre>{toJsonString(jobDetails.payload.children || [])}</pre>
                  </div>
                  <div>
                    <h4 className="block-title">Logs (latest)</h4>
                    <pre>{toJsonString((jobDetails.payload.logs || []).slice(0, 200))}</pre>
                  </div>
                </div>
              ) : null}
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
