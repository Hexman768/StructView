package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

type rpcRequest struct {
	ID     int             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type rpcResponse struct {
	ID     int         `json:"id"`
	OK     bool        `json:"ok"`
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
}

type parseParams struct {
	Text string `json:"text"`
}

type parseResult struct {
	OK       bool        `json:"ok"`
	Format   string      `json:"format,omitempty"`
	Data     interface{} `json:"data,omitempty"`
	DocKey   string      `json:"docKey,omitempty"`
	Fallback bool        `json:"fallback,omitempty"`
	Error    string      `json:"error,omitempty"`
}

type searchParams struct {
	Source string `json:"source"`
	DocKey string `json:"docKey"`
	Query  string `json:"query"`
	Limit  int    `json:"limit"`
}

type searchHit struct {
	Path   []interface{} `json:"path"`
	Target string        `json:"target"`
}

type searchResult struct {
	OK      bool        `json:"ok"`
	DocKey  string      `json:"docKey,omitempty"`
	Query   string      `json:"query,omitempty"`
	Count   int         `json:"count,omitempty"`
	Results []searchHit `json:"results,omitempty"`
	Error   string      `json:"error,omitempty"`
}

type treeRowsParams struct {
	Source             string   `json:"source"`
	DocKey             string   `json:"docKey"`
	Query              string   `json:"query"`
	ExpandedPaths      []string `json:"expandedPaths"`
	DefaultExpandDepth int      `json:"defaultExpandDepth"`
}

type treeRow struct {
	ID            int    `json:"id"`
	ParentID      int    `json:"parentId"`
	Depth         int    `json:"depth"`
	PathToken     string `json:"pathToken"`
	Label         string `json:"label"`
	NodeType      string `json:"nodeType"`
	Meta          string `json:"meta"`
	IndexMeta     string `json:"indexMeta"`
	PrimitiveText string `json:"primitiveText"`
	EditValue     string `json:"editValue"`
	IsBranch      bool   `json:"isBranch"`
	IsOpen        bool   `json:"isOpen"`
	CanRename     bool   `json:"canRename"`
	HasDrag       bool   `json:"hasDrag"`
	KeyMatch      bool   `json:"keyMatch"`
	ValueMatch    bool   `json:"valueMatch"`
}

type treeRowsResult struct {
	OK      bool        `json:"ok"`
	DocKey  string      `json:"docKey,omitempty"`
	Rows    []treeRow   `json:"rows,omitempty"`
	Matches []searchHit `json:"matches,omitempty"`
	Error   string      `json:"error,omitempty"`
}

type cachedDocument struct {
	Data      interface{}
	Format    string
	SourceLen int
	TouchedAt time.Time
}

var (
	docMu         sync.RWMutex
	docByKey      = map[string]cachedDocument{}
	docCounter    uint64
	maxCachedDocs = 16
)

func main() {
	reader := bufio.NewReader(os.Stdin)
	writer := bufio.NewWriter(os.Stdout)
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)

	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if err == io.EOF {
				return
			}
			_ = writeResponse(encoder, writer, rpcResponse{
				ID:    0,
				OK:    false,
				Error: fmt.Sprintf("stdin read failed: %v", err),
			})
			return
		}

		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}

		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			_ = writeResponse(encoder, writer, rpcResponse{
				ID:    0,
				OK:    false,
				Error: fmt.Sprintf("invalid request: %v", err),
			})
			continue
		}

		res := handleRequest(req)
		if err := writeResponse(encoder, writer, res); err != nil {
			return
		}
	}
}

func writeResponse(encoder *json.Encoder, writer *bufio.Writer, res rpcResponse) error {
	if err := encoder.Encode(res); err != nil {
		return err
	}
	return writer.Flush()
}

func handleRequest(req rpcRequest) rpcResponse {
	switch req.Method {
	case "parse":
		var params parseParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return rpcResponse{ID: req.ID, OK: false, Error: fmt.Sprintf("invalid parse params: %v", err)}
		}
		return rpcResponse{ID: req.ID, OK: true, Result: parseInput(params.Text)}
	case "search":
		var params searchParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return rpcResponse{ID: req.ID, OK: false, Error: fmt.Sprintf("invalid search params: %v", err)}
		}
		return rpcResponse{ID: req.ID, OK: true, Result: searchInput(params)}
	case "buildTreeRows":
		var params treeRowsParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return rpcResponse{ID: req.ID, OK: false, Error: fmt.Sprintf("invalid tree rows params: %v", err)}
		}
		return rpcResponse{ID: req.ID, OK: true, Result: buildTreeRowsInput(params)}
	default:
		return rpcResponse{ID: req.ID, OK: false, Error: fmt.Sprintf("unknown method: %s", req.Method)}
	}
}

func parseInput(text string) parseResult {
	source := strings.TrimSpace(text)
	if source == "" {
		return parseResult{OK: false, Error: "Paste JSON or YAML to begin."}
	}

	var jsonValue interface{}
	if err := json.Unmarshal([]byte(source), &jsonValue); err == nil {
		normalized := normalizeValue(jsonValue)
		docKey := cacheDocument(source, "JSON", normalized)
		return parseResult{OK: true, Format: "JSON", Data: normalized, DocKey: docKey}
	}

	var yamlValue interface{}
	if err := yaml.Unmarshal([]byte(source), &yamlValue); err == nil {
		normalized := normalizeValue(yamlValue)
		docKey := cacheDocument(source, "YAML", normalized)
		return parseResult{OK: true, Format: "YAML", Data: normalized, DocKey: docKey}
	}

	var jsonErr error
	if err := json.Unmarshal([]byte(source), &jsonValue); err != nil {
		jsonErr = err
	}
	var yamlErr error
	if err := yaml.Unmarshal([]byte(source), &yamlValue); err != nil {
		yamlErr = err
	}

	return parseResult{
		OK: false,
		Error: fmt.Sprintf(
			"Unable to parse input as JSON or YAML. JSON error: %v. YAML error: %v",
			jsonErr,
			yamlErr,
		),
	}
}

func searchInput(params searchParams) searchResult {
	limit := params.Limit
	if limit <= 0 {
		limit = 2000
	}

	data, _, docKey, err := resolveDocument(params.DocKey, params.Source)
	if err != nil {
		return searchResult{OK: false, Error: err.Error()}
	}

	results := searchPaths(data, params.Query, limit)
	return searchResult{
		OK:      true,
		DocKey:  docKey,
		Query:   strings.TrimSpace(params.Query),
		Count:   len(results),
		Results: results,
	}
}

func buildTreeRowsInput(params treeRowsParams) treeRowsResult {
	data, _, docKey, err := resolveDocument(params.DocKey, params.Source)
	if err != nil {
		return treeRowsResult{OK: false, Error: err.Error()}
	}

	query := strings.ToLower(strings.TrimSpace(params.Query))
	defaultExpandDepth := params.DefaultExpandDepth
	if defaultExpandDepth <= 0 {
		defaultExpandDepth = 2
	}

	expandedPaths := make(map[string]struct{}, len(params.ExpandedPaths))
	for _, token := range params.ExpandedPaths {
		expandedPaths[token] = struct{}{}
	}

	type frame struct {
		label     string
		value     interface{}
		depth     int
		parentID  int
		path      []interface{}
		indexMeta string
	}

	stack := []frame{{
		label:     "root",
		value:     data,
		depth:     0,
		parentID:  0,
		path:      []interface{}{},
		indexMeta: "",
	}}

	rows := make([]treeRow, 0, 4096)
	matches := make([]searchHit, 0, 128)
	nextID := 1

	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]

		pathToken := pathToken(current.path)
		isBranch := isObject(current.value) || isArray(current.value)
		nodeTypeLabel := nodeType(current.value)
		canRename := len(current.path) > 0
		hasDrag := len(current.path) > 0
		isOpen := false
		metaText := ""
		primitiveTextValue := ""
		editValue := ""
		keyMatch := false
		valueMatch := false

		if query != "" && strings.Contains(strings.ToLower(current.label), query) {
			keyMatch = true
			matches = append(matches, searchHit{Path: clonePath(current.path), Target: "key"})
		}

		if isBranch {
			isOpen = current.depth < defaultExpandDepth
			if _, found := expandedPaths[pathToken]; found {
				isOpen = true
			}
			metaText = branchMetaText(current.value, current.indexMeta)
		} else {
			primitiveTextValue = formatPrimitive(current.value)
			editValue = jsonLiteral(current.value)
			if query != "" && strings.Contains(strings.ToLower(primitiveTextValue), query) {
				valueMatch = true
				matches = append(matches, searchHit{Path: clonePath(current.path), Target: "value"})
			}
		}

		rowID := nextID
		nextID += 1
		rows = append(rows, treeRow{
			ID:            rowID,
			ParentID:      current.parentID,
			Depth:         current.depth,
			PathToken:     pathToken,
			Label:         current.label,
			NodeType:      nodeTypeLabel,
			Meta:          metaText,
			IndexMeta:     current.indexMeta,
			PrimitiveText: primitiveTextValue,
			EditValue:     editValue,
			IsBranch:      isBranch,
			IsOpen:        isOpen,
			CanRename:     canRename,
			HasDrag:       hasDrag,
			KeyMatch:      keyMatch,
			ValueMatch:    valueMatch,
		})

		if !isBranch || !isOpen {
			continue
		}

		if items, ok := current.value.([]interface{}); ok {
			for index := len(items) - 1; index >= 0; index-- {
				item := items[index]
				stack = append(stack, frame{
					label:     getArrayItemLabel(item),
					value:     item,
					depth:     current.depth + 1,
					parentID:  rowID,
					path:      appendPath(current.path, index),
					indexMeta: fmt.Sprintf("index %d", index),
				})
			}
			continue
		}

		if obj, ok := current.value.(map[string]interface{}); ok {
			keys := make([]string, 0, len(obj))
			for key := range obj {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for i := len(keys) - 1; i >= 0; i-- {
				key := keys[i]
				stack = append(stack, frame{
					label:     key,
					value:     obj[key],
					depth:     current.depth + 1,
					parentID:  rowID,
					path:      appendPath(current.path, key),
					indexMeta: "",
				})
			}
		}
	}

	return treeRowsResult{OK: true, DocKey: docKey, Rows: rows, Matches: matches}
}

func resolveDocument(docKey string, source string) (interface{}, string, string, error) {
	trimmedKey := strings.TrimSpace(docKey)
	if trimmedKey != "" {
		if doc, ok := getCachedDocument(trimmedKey); ok {
			return doc.Data, doc.Format, trimmedKey, nil
		}
	}

	parsed := parseInput(source)
	if !parsed.OK {
		return nil, "", "", fmt.Errorf(parsed.Error)
	}
	return parsed.Data, parsed.Format, parsed.DocKey, nil
}

func getCachedDocument(docKey string) (cachedDocument, bool) {
	docMu.RLock()
	doc, found := docByKey[docKey]
	docMu.RUnlock()
	if !found {
		return cachedDocument{}, false
	}

	docMu.Lock()
	doc.TouchedAt = time.Now()
	docByKey[docKey] = doc
	docMu.Unlock()
	return doc, true
}

func cacheDocument(source string, format string, data interface{}) string {
	digest := hashSource(source)
	docMu.Lock()
	defer docMu.Unlock()
	docCounter += 1
	docKey := fmt.Sprintf("%x-%d-%d", digest, len(source), docCounter)
	docByKey[docKey] = cachedDocument{
		Data:      data,
		Format:    format,
		SourceLen: len(source),
		TouchedAt: time.Now(),
	}
	pruneCacheLocked()
	return docKey
}

func pruneCacheLocked() {
	if len(docByKey) <= maxCachedDocs {
		return
	}
	type pair struct {
		key string
		at  time.Time
	}
	pairs := make([]pair, 0, len(docByKey))
	for key, doc := range docByKey {
		pairs = append(pairs, pair{key: key, at: doc.TouchedAt})
	}
	sort.Slice(pairs, func(i, j int) bool {
		return pairs[i].at.Before(pairs[j].at)
	})
	for i := 0; i < len(pairs)-maxCachedDocs; i++ {
		delete(docByKey, pairs[i].key)
	}
}

func hashSource(source string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(source))
	return h.Sum64()
}

func searchPaths(root interface{}, query string, limit int) []searchHit {
	normalized := strings.ToLower(strings.TrimSpace(query))
	if normalized == "" || limit <= 0 {
		return []searchHit{}
	}

	type frame struct {
		Value interface{}
		Path  []interface{}
	}

	stack := []frame{{Value: root, Path: []interface{}{}}}
	results := make([]searchHit, 0, min(limit, 128))
	seen := map[string]struct{}{}

	for len(stack) > 0 && len(results) < limit {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]

		switch value := current.Value.(type) {
		case []interface{}:
			for i := len(value) - 1; i >= 0; i-- {
				childPath := appendPath(current.Path, i)
				stack = append(stack, frame{Value: value[i], Path: childPath})
			}
		case map[string]interface{}:
			keys := make([]string, 0, len(value))
			for key := range value {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for i := len(keys) - 1; i >= 0; i-- {
				key := keys[i]
				child := value[key]
				childPath := appendPath(current.Path, key)
				if strings.Contains(strings.ToLower(key), normalized) {
					token := pathToken(childPath)
					if _, exists := seen[token]; !exists {
						seen[token] = struct{}{}
						results = append(results, searchHit{Path: childPath, Target: "key"})
						if len(results) >= limit {
							break
						}
					}
				}
				stack = append(stack, frame{Value: child, Path: childPath})
			}
		default:
			if strings.Contains(strings.ToLower(primitiveText(value)), normalized) {
				token := pathToken(current.Path)
				if _, exists := seen[token]; !exists {
					seen[token] = struct{}{}
					results = append(results, searchHit{Path: current.Path, Target: "value"})
				}
			}
		}
	}

	return results
}

func normalizeValue(value interface{}) interface{} {
	switch current := value.(type) {
	case map[string]interface{}:
		normalized := make(map[string]interface{}, len(current))
		for key, child := range current {
			normalized[key] = normalizeValue(child)
		}
		return normalized
	case map[interface{}]interface{}:
		normalized := make(map[string]interface{}, len(current))
		for key, child := range current {
			normalized[fmt.Sprintf("%v", key)] = normalizeValue(child)
		}
		return normalized
	case []interface{}:
		normalized := make([]interface{}, len(current))
		for index, child := range current {
			normalized[index] = normalizeValue(child)
		}
		return normalized
	default:
		return current
	}
}

func clonePath(path []interface{}) []interface{} {
	cloned := make([]interface{}, len(path))
	copy(cloned, path)
	return cloned
}

func isObject(value interface{}) bool {
	_, ok := value.(map[string]interface{})
	return ok
}

func isArray(value interface{}) bool {
	_, ok := value.([]interface{})
	return ok
}

func nodeType(value interface{}) string {
	if isArray(value) {
		return "Array"
	}
	if isObject(value) {
		return "Object"
	}
	return "Value"
}

func branchMetaText(value interface{}, indexMeta string) string {
	if items, ok := value.([]interface{}); ok {
		countText := fmt.Sprintf("%d item", len(items))
		if len(items) != 1 {
			countText += "s"
		}
		if indexMeta != "" {
			return fmt.Sprintf("%s • %s", indexMeta, countText)
		}
		return countText
	}

	obj, ok := value.(map[string]interface{})
	if !ok {
		if indexMeta != "" {
			return indexMeta
		}
		return ""
	}

	sizeText := fmt.Sprintf("%d field", len(obj))
	if len(obj) != 1 {
		sizeText += "s"
	}
	if indexMeta != "" {
		return fmt.Sprintf("%s • %s", indexMeta, sizeText)
	}
	return sizeText
}

func formatPrimitive(value interface{}) string {
	switch typed := value.(type) {
	case string:
		return fmt.Sprintf("\"%s\"", typed)
	case nil:
		return "null"
	default:
		return fmt.Sprintf("%v", typed)
	}
}

func jsonLiteral(value interface{}) string {
	raw, err := json.Marshal(value)
	if err == nil {
		return string(raw)
	}
	return fmt.Sprintf("%v", value)
}

func getArrayItemLabel(item interface{}) string {
	if obj, ok := item.(map[string]interface{}); ok {
		keys := make([]string, 0, len(obj))
		for key := range obj {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		if len(keys) == 1 {
			return keys[0]
		}
		preferredKeys := []string{"name", "id", "title", "label", "key", "dtaName"}
		for _, preferredKey := range preferredKeys {
			if preferredValue, exists := obj[preferredKey]; exists {
				if preferredValue != nil {
					switch preferredValue.(type) {
					case map[string]interface{}, []interface{}:
						continue
					default:
						return fmt.Sprintf("%s: %v", preferredKey, preferredValue)
					}
				}
			}
		}
	}
	if text, ok := item.(string); ok {
		if len(text) > 26 {
			return text[:26] + "..."
		}
		return text
	}
	return "item"
}

func primitiveText(value interface{}) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case string:
		return v
	default:
		return fmt.Sprintf("%v", v)
	}
}

func appendPath(path []interface{}, segment interface{}) []interface{} {
	next := make([]interface{}, len(path)+1)
	copy(next, path)
	next[len(path)] = segment
	return next
}

func pathToken(path []interface{}) string {
	raw, err := json.Marshal(path)
	if err != nil {
		return fmt.Sprintf("%v", path)
	}
	return string(raw)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
