import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch, apiFetchWithRetry, formatError, toJsonString } from './lib/api';
import {
  buildMappingFromFields,
  columnLetter,
  createEmptyMappingFields,
  parseMappingToFields
} from './lib/mapping';
import { Tag } from './components/ui';
import { ToastViewport } from './components/toast';
import { OverviewTab } from './tabs/OverviewTab';
import { SuppliersTab } from './tabs/SuppliersTab';
import { MappingTab } from './tabs/MappingTab';
import { PricingTab } from './tabs/PricingTab';
import { DataTab } from './tabs/DataTab';
import { JobsTab } from './tabs/JobsTab';

const TABS = [
  { id: 'overview', label: 'Панель' },
  { id: 'suppliers', label: 'Постачальники' },
  { id: 'data', label: 'Дані' },
  { id: 'jobs', label: 'Моніторинг' }
];

const SOURCE_TYPES = ['google_sheet', 'csv', 'xml', 'json'];
const MAPPING_KEYS = ['article', 'size', 'quantity', 'price', 'extra', 'comment'];
const TOAST_LIMIT = 6;
const TOAST_TTL_MS = 5500;

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
  const [authReady, setAuthReady] = useState(false);
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
  const [toasts, setToasts] = useState([]);

  const [suppliers, setSuppliers] = useState([]);
  const [supplierSearch, setSupplierSearch] = useState('');
  const [supplierSort, setSupplierSort] = useState('name_asc');
  const [suppliersStatus, setSuppliersStatus] = useState('');
  const [supplierDraft, setSupplierDraft] = useState(() => toSupplierDraft(null));
  const [supplierErrors, setSupplierErrors] = useState({});
  const [editingSupplierId, setEditingSupplierId] = useState('');
  const [supplierFormStatus, setSupplierFormStatus] = useState('');
  const [selectedSupplierIds, setSelectedSupplierIds] = useState([]);

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
  const [supplierBulkPricingStatus, setSupplierBulkPricingStatus] = useState('');
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

  const selectedSupplierName = useMemo(() => {
    const matched = suppliers.find((supplier) => String(supplier.id) === String(selectedSupplierId));
    return matched?.name || '';
  }, [suppliers, selectedSupplierId]);

  const recentErrorLogs = useMemo(
    () => logs.filter((item) => String(item.level || '').toLowerCase() === 'error').slice(0, 8),
    [logs]
  );

  const dismissToast = (id) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  };

  const pushToast = (tone, title, details = '') => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, tone, title, details }].slice(-TOAST_LIMIT));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, TOAST_TTL_MS);
  };

  const humanizeActionLabel = (label) =>
    String(label || 'action')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

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
    const actionLabel = humanizeActionLabel(label);
    try {
      const result = await run();
      setTopStatus('');
      clearFailedAction();
      pushToast('ok', 'Операція виконана', actionLabel);
      return result;
    } catch (error) {
      rememberFailedAction(label, run);
      setTopStatus(`Failed: ${label}. Use "Retry failed".`);
      pushToast('error', 'Операція завершилась помилкою', `${actionLabel}: ${formatError(error)}`);
      throw error;
    }
  };

  const confirmWithKeyword = ({ title, details, keyword }) => {
    const promptText = [title, details, `Введіть "${keyword}" для підтвердження.`]
      .filter(Boolean)
      .join('\n');
    const answer = window.prompt(promptText);
    const confirmed = String(answer || '').trim() === keyword;
    if (!confirmed) {
      pushToast('warn', 'Дію скасовано', 'Підтвердження не пройдено');
    }
    return confirmed;
  };

  const retryLastFailedAction = async () => {
    if (!lastFailedAction?.run) {
      return;
    }
    setTopStatus(`Retry: ${lastFailedAction.label}...`);
    pushToast('info', 'Повтор дії', humanizeActionLabel(lastFailedAction.label));
    try {
      await lastFailedAction.run();
      setTopStatus(`Retry success: ${lastFailedAction.label}`);
      pushToast('ok', 'Повтор успішний', humanizeActionLabel(lastFailedAction.label));
      clearFailedAction();
      await refreshCore();
    } catch (error) {
      setTopStatus(`Retry failed: ${formatError(error)}`);
      pushToast('error', 'Повтор завершився помилкою', formatError(error));
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
    if (supplierDraft.markup_rule_set_id.trim()) {
      const parsedRuleSetId = parsePositiveInt(supplierDraft.markup_rule_set_id);
      if (!parsedRuleSetId) {
        errors.markup_rule_set_id = 'Оберіть коректний тип націнки';
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

  const resetMappingDraft = () => {
    setMappingText('{}');
    setMappingComment('');
    setMappingHeaderRow('1');
    setMappingFields(createEmptyMappingFields());
    setMappingErrors({});
    setMappingStatus('Новий мапінг: заповніть поля і збережіть');
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

  const applyRuleSetToSelectedSuppliers = async (ruleSetIdRaw) => {
    const ruleSetId = Number(ruleSetIdRaw);
    if (!Number.isFinite(ruleSetId) || ruleSetId <= 0) {
      setSupplierBulkPricingStatus('Оберіть тип націнки');
      return;
    }
    if (selectedSupplierIds.length === 0) {
      setSupplierBulkPricingStatus('Оберіть хоча б одного постачальника');
      return;
    }
    setSupplierBulkPricingStatus('Застосування типу націнки...');
    try {
      const result = await runMutationWithRetryUX(`apply_ruleset_${ruleSetId}_selected_suppliers`, () =>
        apiFetchWithRetry(
          '/markup-rule-sets/apply',
          {
            method: 'POST',
            body: JSON.stringify({
              scope: 'suppliers',
              supplier_ids: selectedSupplierIds,
              rule_set_id: ruleSetId
            })
          },
          { retries: 1 }
        )
      );
      const updatedSuppliers = Number(result?.updated_suppliers || 0);
      const statusText = `Тип націнки застосовано: updated=${updatedSuppliers}`;
      setSupplierBulkPricingStatus(statusText);
      setPricingStatus(statusText);
      setPricingApplyRuleSetId(String(ruleSetId));
      await refreshSuppliers();
    } catch (error) {
      const errorText = formatError(error);
      setSupplierBulkPricingStatus(errorText);
      setPricingStatus(errorText);
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
        const me = await apiFetch('/me');
        setMeRole(me?.role || null);
        setApiStatus('ok');
      } catch (error) {
        if (Number(error?.status) === 401) {
          setMeRole(null);
          setAuthReady(true);
          return;
        }
        setApiStatus('error');
        setMeRole(null);
        setAuthReady(true);
        return;
      }

      await Promise.all([
        refreshCore(),
        refreshSuppliers(),
        refreshMarkupRuleSets(),
        refreshPriceOverrides()
      ]);
      setAuthReady(true);
    };
    void boot();
  }, []);

  useEffect(() => {
    void refreshSources(selectedSupplierId);
  }, [selectedSupplierId]);

  useEffect(() => {
    void refreshMapping(selectedSupplierId, selectedSourceId);
  }, [selectedSupplierId, selectedSourceId]);

  if (!authReady) {
    return (
      <div className="app">
        <div className="panel">
          <h3>Перевірка авторизації...</h3>
        </div>
      </div>
    );
  }

  if (!meRole) {
    const nextPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const loginHref = `/admin/login?next=${encodeURIComponent(nextPath || '/admin')}`;
    return (
      <div className="app">
        <div className="panel">
          <h3>Потрібна авторизація</h3>
          <p className="muted">Сесія не знайдена або протермінована.</p>
          <div className="actions">
            <a className="btn primary" href={loginHref}>Перейти на сторінку логіну</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <ToastViewport items={toasts} onDismiss={dismissToast} />
      <div className="topbar">
        <div className="title-block">
          <h1>Whitehall CS-Cart Admin</h1>
          <p>
            Операційна панель для пайплайна CS-Cart: мінімум шуму, швидкі дії, без зміни
            бізнес-логіки бекенду.
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
        <OverviewTab
          readiness={readiness}
          stats={stats}
          recentErrorLogs={recentErrorLogs}
          openJobDetails={openJobDetails}
          suppliers={suppliers}
          selectedSupplierId={selectedSupplierId}
          setSelectedSupplierId={setSelectedSupplierId}
          sources={sources}
          selectedSourceId={selectedSourceId}
          setSelectedSourceId={setSelectedSourceId}
          actionForm={actionForm}
          setActionForm={setActionForm}
          isReadOnly={isReadOnly}
          runJob={runJob}
          runStoreImport={runStoreImport}
          runCleanupWithPreflight={runCleanupWithPreflight}
          actionStatus={actionStatus}
        />
      ) : null}

      {tab === 'suppliers' ? (
        <SuppliersTab
          refreshSuppliers={refreshSuppliers}
          supplierSearch={supplierSearch}
          setSupplierSearch={setSupplierSearch}
          supplierSort={supplierSort}
          setSupplierSort={setSupplierSort}
          selectedSupplierIds={selectedSupplierIds}
          setSelectedSupplierIds={setSelectedSupplierIds}
          suppliers={suppliers}
          setEditingSupplierId={setEditingSupplierId}
          setSupplierDraft={setSupplierDraft}
          setSupplierErrors={setSupplierErrors}
          setSelectedSupplierId={setSelectedSupplierId}
          toSupplierDraft={toSupplierDraft}
          deleteSupplier={deleteSupplier}
          isReadOnly={isReadOnly}
          suppliersStatus={suppliersStatus}
          editingSupplierId={editingSupplierId}
          supplierDraft={supplierDraft}
          supplierErrors={supplierErrors}
          supplierFormStatus={supplierFormStatus}
          saveSupplier={saveSupplier}
          markupRuleSets={markupRuleSets}
          globalRuleSetId={globalRuleSetId}
          applyRuleSetToSelectedSuppliers={applyRuleSetToSelectedSuppliers}
          supplierBulkPricingStatus={supplierBulkPricingStatus}
          mappingPanel={(
            <MappingTab
              selectedSupplierId={selectedSupplierId}
              setSelectedSupplierId={setSelectedSupplierId}
              suppliers={suppliers}
              selectedSourceId={selectedSourceId}
              setSelectedSourceId={setSelectedSourceId}
              sources={sources}
              refreshSources={refreshSources}
              setEditingSourceId={setEditingSourceId}
              setSourceDraft={setSourceDraft}
              setSourceErrors={setSourceErrors}
              toSourceDraft={toSourceDraft}
              deleteSource={deleteSource}
              isReadOnly={isReadOnly}
              sourcesStatus={sourcesStatus}
              editingSourceId={editingSourceId}
              sourceDraft={sourceDraft}
              sourceTypes={SOURCE_TYPES}
              sourceErrors={sourceErrors}
              parseSourceUrlHint={parseSourceUrlHint}
              saveSource={saveSource}
              sourceFormStatus={sourceFormStatus}
              sourceSheets={sourceSheets}
              selectedSheetName={selectedSheetName}
              setSelectedSheetName={setSelectedSheetName}
              mappingHeaderRow={mappingHeaderRow}
              setMappingHeaderRow={setMappingHeaderRow}
              loadSourceSheets={loadSourceSheets}
              loadSourcePreview={loadSourcePreview}
              sourceSheetsStatus={sourceSheetsStatus}
              sourcePreview={sourcePreview}
              mappingKeys={MAPPING_KEYS}
              mappingFields={mappingFields}
              updateMappingField={updateMappingField}
              mappingColumnOptions={mappingColumnOptions}
              applyBuilderToJson={applyBuilderToJson}
              refreshMapping={refreshMapping}
              mappingErrors={mappingErrors}
              mappingComment={mappingComment}
              setMappingComment={setMappingComment}
              mappingText={mappingText}
              setMappingText={setMappingText}
              saveMapping={saveMapping}
              mappingStatus={mappingStatus}
              resetMappingDraft={resetMappingDraft}
              supplierLocked
              supplierLockedName={selectedSupplierName}
            />
          )}
          pricingPanel={(
            <PricingTab
              refreshMarkupRuleSets={refreshMarkupRuleSets}
              pricingApplyRuleSetId={pricingApplyRuleSetId}
              setPricingApplyRuleSetId={setPricingApplyRuleSetId}
              markupRuleSets={markupRuleSets}
              isReadOnly={isReadOnly}
              setDefaultMarkupRuleSet={setDefaultMarkupRuleSet}
              startCreateRuleSet={startCreateRuleSet}
              globalRuleSetId={globalRuleSetId}
              pricingStatus={pricingStatus}
              startEditRuleSet={startEditRuleSet}
              ruleSetDraft={ruleSetDraft}
              setRuleSetDraft={setRuleSetDraft}
              ruleSetErrors={ruleSetErrors}
              updateRuleCondition={updateRuleCondition}
              removeRuleCondition={removeRuleCondition}
              addRuleCondition={addRuleCondition}
              saveRuleSet={saveRuleSet}
              ruleSetStatus={ruleSetStatus}
              priceOverrideFilters={priceOverrideFilters}
              setPriceOverrideFilters={setPriceOverrideFilters}
              refreshPriceOverrides={refreshPriceOverrides}
              priceOverrideDraft={priceOverrideDraft}
              setPriceOverrideDraft={setPriceOverrideDraft}
              priceOverrideErrors={priceOverrideErrors}
              savePriceOverride={savePriceOverride}
              toPriceOverrideDraft={toPriceOverrideDraft}
              priceOverrideStatus={priceOverrideStatus}
              priceOverrides={priceOverrides}
            />
          )}
        />
      ) : null}

      {tab === 'data' ? (
        <DataTab
          dataFilters={dataFilters}
          setDataFilters={setDataFilters}
          activeDataView={activeDataView}
          setActiveDataView={setActiveDataView}
          loadMerged={loadMerged}
          loadFinal={loadFinal}
          loadCompare={loadCompare}
          shiftDataOffset={shiftDataOffset}
          mergedState={mergedState}
          finalState={finalState}
          compareState={compareState}
        />
      ) : null}

      {tab === 'jobs' ? (
        <JobsTab
          refreshCore={refreshCore}
          jobsStatus={jobsStatus}
          jobs={jobs}
          openJobDetails={openJobDetails}
          isReadOnly={isReadOnly}
          cancelJob={cancelJob}
          logsLevel={logsLevel}
          setLogsLevel={setLogsLevel}
          logsJobId={logsJobId}
          setLogsJobId={setLogsJobId}
          logs={logs}
          jobDetails={jobDetails}
          closeJobDetails={closeJobDetails}
        />
      ) : null}
    </div>
  );
}
