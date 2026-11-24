import 'dart:convert';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../services/api_service.dart';

const _lostFoundCategories = [
  'Bag',
  'Book',
  'Clothing',
  'Electronic device',
  'ID card',
  'Keys',
  'Bottle',
  'Other',
];

class LostFoundScreen extends StatefulWidget {
  const LostFoundScreen({super.key});

  @override
  State<LostFoundScreen> createState() => _LostFoundScreenState();
}

class _LostFoundScreenState extends State<LostFoundScreen> {
  List<Map<String, dynamic>> _reports = [];
  final TextEditingController _searchController = TextEditingController();
  bool _loading = true;
  String? _error;
  String _selectedReportType = 'all';
  String _selectedStatus = 'all';

  ApiService get _api => AppScope.read(context).api;
  bool get _isStudent => AppScope.read(context).auth.user?.isStudent == true;
  bool get _isAdmin => AppScope.read(context).auth.user?.isAdmin == true;

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadReports());
  }

  Future<void> _loadReports() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final reports = await _api.getLostFoundReports(
        reportType: _selectedReportType == 'all' ? null : _selectedReportType,
        status: _selectedStatus == 'all' ? null : _selectedStatus,
      );
      if (mounted) setState(() => _reports = reports);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _showMessage(String message) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _createReport() async {
    final report = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (_) => const _LostFoundReportDialog(),
    );
    if (report == null) return;
    try {
      await _api.createLostFoundReport(report);
      await _loadReports();
      _showMessage('Lost and Found report submitted.');
    } on ApiException catch (error) {
      _showMessage(error.message);
    }
  }

  Future<void> _showDetails(Map<String, dynamic> report) async {
    try {
      final detail = await _api.getLostFoundReport('${report['id']}');
      if (!mounted) return;
      final analysis = detail['ai_analysis'];
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text('${detail['item_name'] ?? 'Report details'}'),
          content: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (detail['image_url'] is String)
                  _AuthenticatedImage(
                    imageUrl: detail['image_url'] as String,
                    width: 360,
                    height: 180,
                  ),
                _DetailLine('Report', '${detail['report_type'] ?? ''}'),
                _DetailLine('Status', '${detail['status'] ?? ''}'),
                _DetailLine('Category', '${detail['category'] ?? ''}'),
                _DetailLine('Colour', '${detail['colour'] ?? ''}'),
                _DetailLine('Brand', '${detail['brand'] ?? 'Not provided'}'),
                _DetailLine('When', _dateTime(detail)),
                _DetailLine('Location', '${detail['location'] ?? ''}'),
                _DetailLine('Description', '${detail['description'] ?? ''}'),
                if ('${detail['additional_details'] ?? ''}'.isNotEmpty)
                  _DetailLine(
                    'Additional details',
                    '${detail['additional_details']}',
                  ),
                if (analysis is Map) ...[
                  const Divider(),
                  const Text(
                    'AI image analysis (experimental)',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  _DetailLine(
                    'Suggested category',
                    '${analysis['predicted_category'] ?? 'Unavailable'}',
                  ),
                  _DetailLine(
                    'Suggested colour',
                    '${analysis['predicted_colour'] ?? 'Unavailable'}',
                  ),
                  const Text(
                    'Similarity suggestions are not proof of ownership.',
                  ),
                ],
              ],
            ),
          ),
          actions: [
            if (analysis is Map && _isStudent && detail['status'] == 'active')
              TextButton(
                onPressed: () async {
                  Navigator.of(dialogContext).pop();
                  await _editSuggestions(detail, analysis);
                },
                child: const Text('Review AI suggestions'),
              ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Close'),
            ),
          ],
        ),
      );
    } on ApiException catch (error) {
      _showMessage(error.message);
    }
  }

  Future<void> _editSuggestions(
    Map<String, dynamic> report,
    Map<dynamic, dynamic> analysis,
  ) async {
    final category = ValueNotifier<String>(
      _lostFoundCategories.contains(analysis['predicted_category'])
          ? analysis['predicted_category'] as String
          : '${report['category']}',
    );
    final colour = TextEditingController(
      text: '${analysis['predicted_colour'] ?? report['colour'] ?? ''}',
    );
    final accepted = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Review AI suggestions'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ValueListenableBuilder<String>(
              valueListenable: category,
              builder: (context, value, _) => DropdownButtonFormField<String>(
                initialValue: value,
                decoration: const InputDecoration(labelText: 'Category'),
                items: _lostFoundCategories
                    .map(
                      (item) =>
                          DropdownMenuItem(value: item, child: Text(item)),
                    )
                    .toList(),
                onChanged: (next) {
                  if (next != null) category.value = next;
                },
              ),
            ),
            TextField(
              controller: colour,
              maxLength: 60,
              decoration: const InputDecoration(labelText: 'Colour'),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Apply'),
          ),
        ],
      ),
    );
    if (accepted == true) {
      try {
        await _api.applyLostFoundSuggestions(
          reportId: '${report['id']}',
          category: category.value,
          colour: colour.text.trim(),
        );
        await _loadReports();
        _showMessage('AI suggestions applied to this report.');
      } on ApiException catch (error) {
        _showMessage(error.message);
      }
    }
    category.dispose();
    colour.dispose();
  }

  Future<void> _showMatches(Map<String, dynamic> report) async {
    try {
      final result = await _api.getLostFoundMatches('${report['id']}');
      if (!mounted) return;
      final matches = (result['items'] as List? ?? const [])
          .whereType<Map>()
          .map(
            (item) => item.map((key, value) => MapEntry(key.toString(), value)),
          )
          .toList();
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('Possible matches'),
          content: SizedBox(
            width: 440,
            child: matches.isEmpty
                ? const Text(
                    'No possible matches are available yet. Matching requires opposite report types within 24 hours.',
                  )
                : ListView.separated(
                    shrinkWrap: true,
                    itemCount: matches.length,
                    separatorBuilder: (_, _) => const Divider(),
                    itemBuilder: (context, index) {
                      final match = matches[index];
                      final status = '${match['match_status'] ?? 'pending'}';
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: match['image_url'] is String
                            ? _AuthenticatedImage(
                                imageUrl: match['image_url'] as String,
                                width: 56,
                                height: 56,
                              )
                            : const Icon(Icons.image_not_supported_outlined),
                        title: Text(
                          '${match['item_name'] ?? 'Potential item'}',
                        ),
                        subtitle: Text(
                          '${match['category'] ?? 'Other'} · '
                          '${match['colour'] ?? 'Unknown'}\n'
                          'Similarity ${match['similarity_score'] ?? 0}% · '
                          '${match['approximate_location'] ?? 'Exact location withheld'}',
                        ),
                        isThreeLine: true,
                        trailing:
                            status == 'verification_pending' ||
                                status == 'approved'
                            ? const Icon(Icons.hourglass_top_rounded)
                            : TextButton(
                                onPressed: () async {
                                  try {
                                    await _api.requestLostFoundMatch(
                                      '${match['id']}',
                                    );
                                    if (dialogContext.mounted) {
                                      Navigator.of(dialogContext).pop();
                                    }
                                    _showMessage(
                                      'Request submitted. Private details remain protected.',
                                    );
                                  } on ApiException catch (error) {
                                    _showMessage(error.message);
                                  }
                                },
                                child: const Text('Request review'),
                              ),
                      );
                    },
                  ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Done'),
            ),
          ],
        ),
      );
    } on ApiException catch (error) {
      _showMessage(error.message);
    }
  }

  Future<void> _showIncomingClaims() async {
    try {
      final claims = await _api.getIncomingLostFoundClaims();
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('Incoming match requests'),
          content: SizedBox(
            width: 440,
            child: claims.isEmpty
                ? const Text('There are no incoming requests.')
                : ListView.separated(
                    shrinkWrap: true,
                    itemCount: claims.length,
                    separatorBuilder: (_, _) => const Divider(),
                    itemBuilder: (context, index) {
                      final claim = claims[index];
                      final request = claim['requesting_report'] is Map
                          ? claim['requesting_report'] as Map
                          : const <String, dynamic>{};
                      final pending = claim['verification_status'] == 'pending';
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(
                          '${request['item_name'] ?? 'Potential match'}',
                        ),
                        subtitle: Text(
                          '${request['category'] ?? 'Other'} · '
                          '${request['colour'] ?? 'Unknown'} · '
                          '${claim['verification_status'] ?? 'pending'}\n'
                          'A similarity score is not proof of ownership.',
                        ),
                        isThreeLine: true,
                        trailing: pending
                            ? Wrap(
                                children: [
                                  IconButton(
                                    tooltip: 'Approve request',
                                    onPressed: () => _reviewClaim(
                                      dialogContext,
                                      claim,
                                      'approved',
                                    ),
                                    icon: const Icon(
                                      Icons.check_circle_outline,
                                    ),
                                  ),
                                  IconButton(
                                    tooltip: 'Reject request',
                                    onPressed: () => _reviewClaim(
                                      dialogContext,
                                      claim,
                                      'rejected',
                                    ),
                                    icon: const Icon(Icons.cancel_outlined),
                                  ),
                                ],
                              )
                            : const Icon(Icons.check_circle_outline),
                      );
                    },
                  ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Done'),
            ),
          ],
        ),
      );
    } on ApiException catch (error) {
      _showMessage(error.message);
    }
  }

  Future<void> _reviewClaim(
    BuildContext dialogContext,
    Map<String, dynamic> claim,
    String decision,
  ) async {
    try {
      await _api.reviewLostFoundClaim(
        matchId: '${claim['match_id']}',
        claimId: '${claim['id']}',
        decision: decision,
      );
      if (dialogContext.mounted) Navigator.of(dialogContext).pop();
      _showMessage('Request $decision. No private details were revealed.');
    } on ApiException catch (error) {
      _showMessage(error.message);
    }
  }

  Future<void> _changeStatus(Map<String, dynamic> report, String status) async {
    try {
      await _api.updateLostFoundStatus(
        reportId: '${report['id']}',
        status: status,
      );
      await _loadReports();
      _showMessage('Report ${status}d.');
    } on ApiException catch (error) {
      _showMessage(error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final search = _searchController.text.trim().toLowerCase();
    final visibleReports = _reports.where((report) {
      if (search.isEmpty) return true;
      return [
        report['item_name'],
        report['category'],
        report['colour'],
        report['location'],
        report['description'],
      ].any((value) => '${value ?? ''}'.toLowerCase().contains(search));
    }).toList();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Lost and Found'),
        actions: [
          IconButton(
            tooltip: 'Incoming match requests',
            onPressed: _showIncomingClaims,
            icon: const Icon(Icons.inbox_outlined),
          ),
          IconButton(
            tooltip: 'Refresh reports',
            onPressed: _loadReports,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      floatingActionButton: _isStudent
          ? FloatingActionButton.extended(
              onPressed: _createReport,
              icon: const Icon(Icons.add),
              label: const Text('New report'),
            )
          : null,
      body: RefreshIndicator(
        onRefresh: _loadReports,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  _isAdmin
                      ? 'Review incoming match requests. Similarity scores do not verify ownership.'
                      : 'Report lost and found items. Potential matches compare opposite report types within 24 hours; similarity is not proof of ownership.',
                ),
              ),
            ),
            const SizedBox(height: 12),
            SegmentedButton<String>(
              key: const Key('lost_found_report_type_filter'),
              segments: const [
                ButtonSegment(value: 'all', label: Text('All')),
                ButtonSegment(value: 'lost', label: Text('LOST')),
                ButtonSegment(value: 'found', label: Text('FOUND')),
              ],
              selected: {_selectedReportType},
              onSelectionChanged: (selection) {
                setState(() => _selectedReportType = selection.first);
                _loadReports();
              },
            ),
            const SizedBox(height: 8),
            TextField(
              key: const Key('lost_found_search'),
              controller: _searchController,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: 'Search your reports',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: _searchController.text.isEmpty
                    ? null
                    : IconButton(
                        tooltip: 'Clear search',
                        onPressed: () {
                          _searchController.clear();
                          setState(() {});
                        },
                        icon: const Icon(Icons.clear),
                      ),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              key: const Key('lost_found_status_filter'),
              initialValue: _selectedStatus,
              decoration: const InputDecoration(
                labelText: 'Status',
                border: OutlineInputBorder(),
              ),
              items: const [
                DropdownMenuItem(value: 'all', child: Text('All statuses')),
                DropdownMenuItem(value: 'active', child: Text('Active')),
                DropdownMenuItem(
                  value: 'match_found',
                  child: Text('Match found'),
                ),
                DropdownMenuItem(
                  value: 'verification_pending',
                  child: Text('Verification pending'),
                ),
                DropdownMenuItem(value: 'resolved', child: Text('Resolved')),
                DropdownMenuItem(value: 'closed', child: Text('Closed')),
              ],
              onChanged: (value) {
                if (value == null) return;
                setState(() => _selectedStatus = value);
                _loadReports();
              },
            ),
            if (_error != null)
              Card(
                child: ListTile(
                  leading: const Icon(Icons.error_outline),
                  title: Text(_error!),
                  trailing: TextButton(
                    onPressed: _loadReports,
                    child: const Text('Retry'),
                  ),
                ),
              ),
            if (_loading && _reports.isEmpty)
              const Padding(
                padding: EdgeInsets.all(32),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (visibleReports.isEmpty)
              const Padding(
                padding: EdgeInsets.all(24),
                child: Text('No reports match the selected filters.'),
              )
            else
              ...visibleReports.map(_reportCard),
          ],
        ),
      ),
    );
  }

  Widget _reportCard(Map<String, dynamic> report) {
    final isLost = report['report_type'] == 'lost';
    final isActive = report['status'] == 'active';
    return Card(
      margin: const EdgeInsets.only(top: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (report['image_url'] is String)
              _AuthenticatedImage(
                imageUrl: report['image_url'] as String,
                width: double.infinity,
                height: 160,
              ),
            Row(
              children: [
                Chip(label: Text(isLost ? 'Lost' : 'Found')),
                const SizedBox(width: 8),
                Chip(label: Text('${report['status'] ?? 'active'}')),
                const Spacer(),
                Text('${report['category'] ?? 'Other'}'),
              ],
            ),
            Text(
              '${report['item_name'] ?? 'Unnamed item'}',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text('${report['colour'] ?? ''} · ${_dateTime(report)}'),
            Text('${report['location'] ?? ''}'),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                OutlinedButton(
                  onPressed: () => _showDetails(report),
                  child: const Text('Details'),
                ),
                if (isActive && isLost)
                  OutlinedButton(
                    onPressed: () => _showMatches(report),
                    child: const Text('Matches'),
                  ),
                if (isActive && !isLost)
                  OutlinedButton(
                    onPressed: _showIncomingClaims,
                    child: const Text('Incoming requests'),
                  ),
                if (isActive)
                  TextButton(
                    onPressed: () => _changeStatus(report, 'close'),
                    child: const Text('Close'),
                  ),
                if (isActive)
                  TextButton(
                    onPressed: () => _changeStatus(report, 'resolve'),
                    child: const Text('Resolve'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _LostFoundReportDialog extends StatefulWidget {
  const _LostFoundReportDialog();

  @override
  State<_LostFoundReportDialog> createState() => _LostFoundReportDialogState();
}

class _LostFoundReportDialogState extends State<_LostFoundReportDialog> {
  final _formKey = GlobalKey<FormState>();
  final _itemName = TextEditingController();
  final _brand = TextEditingController();
  final _description = TextEditingController();
  final _colour = TextEditingController();
  final _location = TextEditingController();
  final _details = TextEditingController();
  String _reportType = 'lost';
  String _category = _lostFoundCategories.first;
  DateTime _date = DateTime.now();
  TimeOfDay _time = TimeOfDay.now();
  Uint8List? _imageBytes;
  String? _imageName;
  String? _imageType;
  String? _error;

  @override
  void dispose() {
    _itemName.dispose();
    _brand.dispose();
    _description.dispose();
    _colour.dispose();
    _location.dispose();
    _details.dispose();
    super.dispose();
  }

  Future<void> _chooseImage() async {
    final files = await FilePicker.pickFiles(type: FileType.image);
    if (files.isEmpty) return;
    final file = files.first;
    final extension = file.extension?.toLowerCase();
    final type = switch (extension) {
      'jpg' || 'jpeg' => 'image/jpeg',
      'png' => 'image/png',
      'webp' => 'image/webp',
      _ => null,
    };
    if (type == null) {
      setState(() => _error = 'Choose a JPG, PNG, or WebP image.');
      return;
    }
    final size = await file.length();
    if (size == null) {
      setState(() => _error = 'The selected image size could not be read.');
      return;
    }
    if (size > 5 * 1024 * 1024) {
      setState(() => _error = 'Images must be 5 MB or smaller.');
      return;
    }
    final bytes = await file.readAsBytes();
    setState(() {
      _imageBytes = bytes;
      _imageName = file.name;
      _imageType = type;
      _error = null;
    });
  }

  String _dateString() =>
      '${_date.year.toString().padLeft(4, '0')}-'
      '${_date.month.toString().padLeft(2, '0')}-'
      '${_date.day.toString().padLeft(2, '0')}';

  String _timeString() =>
      '${_time.hour.toString().padLeft(2, '0')}:'
      '${_time.minute.toString().padLeft(2, '0')}';

  void _submit() {
    if (!_formKey.currentState!.validate()) return;
    final body = <String, dynamic>{
      'report_type': _reportType,
      'item_name': _itemName.text.trim(),
      'brand': _brand.text.trim(),
      'description': _description.text.trim(),
      'category': _category,
      'colour': _colour.text.trim(),
      'event_date': _dateString(),
      'event_time': _timeString(),
      'location': _location.text.trim(),
      'additional_details': _details.text.trim(),
      if (_imageBytes != null)
        'image': {
          'name': _imageName,
          'type': _imageType,
          'size': _imageBytes!.length,
          'data': base64Encode(_imageBytes!),
        },
    };
    Navigator.of(context).pop(body);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(
        _reportType == 'lost' ? 'Report lost item' : 'Report found item',
      ),
      content: SizedBox(
        width: 480,
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (_error != null)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      _error!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
                DropdownButtonFormField<String>(
                  initialValue: _reportType,
                  decoration: const InputDecoration(labelText: 'Report type'),
                  items: const [
                    DropdownMenuItem(value: 'lost', child: Text('Lost')),
                    DropdownMenuItem(value: 'found', child: Text('Found')),
                  ],
                  onChanged: (value) {
                    if (value != null) setState(() => _reportType = value);
                  },
                ),
                _textField(_itemName, 'Item name', max: 120),
                _textField(
                  _brand,
                  'Brand (optional)',
                  max: 80,
                  required: false,
                ),
                DropdownButtonFormField<String>(
                  initialValue: _category,
                  decoration: const InputDecoration(labelText: 'Category'),
                  items: _lostFoundCategories
                      .map(
                        (value) =>
                            DropdownMenuItem(value: value, child: Text(value)),
                      )
                      .toList(),
                  onChanged: (value) {
                    if (value != null) setState(() => _category = value);
                  },
                ),
                _textField(_colour, 'Colour', max: 60),
                Row(
                  children: [
                    Expanded(
                      child: TextButton.icon(
                        onPressed: () async {
                          final date = await showDatePicker(
                            context: context,
                            initialDate: _date,
                            firstDate: DateTime(2000),
                            lastDate: DateTime.now().add(
                              const Duration(days: 365),
                            ),
                          );
                          if (date != null) setState(() => _date = date);
                        },
                        icon: const Icon(Icons.calendar_today),
                        label: Text(_dateString()),
                      ),
                    ),
                    Expanded(
                      child: TextButton.icon(
                        onPressed: () async {
                          final selected = await showTimePicker(
                            context: context,
                            initialTime: _time,
                          );
                          if (selected != null) {
                            setState(() => _time = selected);
                          }
                        },
                        icon: const Icon(Icons.access_time),
                        label: Text(_timeString()),
                      ),
                    ),
                  ],
                ),
                _textField(_location, 'Location', max: 200),
                _textField(_description, 'Description', max: 1000, lines: 3),
                _textField(
                  _details,
                  'Additional identifying details (optional)',
                  max: 1000,
                  required: false,
                  lines: 2,
                ),
                Align(
                  alignment: Alignment.centerLeft,
                  child: Wrap(
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: 8,
                    children: [
                      OutlinedButton.icon(
                        onPressed: _chooseImage,
                        icon: const Icon(Icons.image_outlined),
                        label: Text(_imageName ?? 'Choose image'),
                      ),
                      if (_imageBytes != null)
                        IconButton(
                          tooltip: 'Remove image',
                          onPressed: () => setState(() {
                            _imageBytes = null;
                            _imageName = null;
                            _imageType = null;
                          }),
                          icon: const Icon(Icons.close),
                        ),
                    ],
                  ),
                ),
                const Align(
                  alignment: Alignment.centerLeft,
                  child: Text('Optional · JPG, PNG, or WebP · maximum 5 MB'),
                ),
              ],
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Submit report')),
      ],
    );
  }

  Widget _textField(
    TextEditingController controller,
    String label, {
    required int max,
    bool required = true,
    int lines = 1,
  }) {
    return TextFormField(
      controller: controller,
      maxLength: max,
      maxLines: lines,
      decoration: InputDecoration(labelText: label),
      validator: (value) {
        if (required && (value == null || value.trim().isEmpty)) {
          return '$label is required.';
        }
        return null;
      },
    );
  }
}

class _DetailLine extends StatelessWidget {
  const _DetailLine(this.label, this.value);

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 6),
    child: Text('$label: $value'),
  );
}

class _AuthenticatedImage extends StatefulWidget {
  const _AuthenticatedImage({
    required this.imageUrl,
    required this.width,
    required this.height,
  });

  final String imageUrl;
  final double width;
  final double height;

  @override
  State<_AuthenticatedImage> createState() => _AuthenticatedImageState();
}

class _AuthenticatedImageState extends State<_AuthenticatedImage> {
  late Future<Uint8List> _image;

  @override
  void initState() {
    super.initState();
    _image = AppScope.read(context).api.getLostFoundImage(widget.imageUrl);
  }

  @override
  void didUpdateWidget(covariant _AuthenticatedImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.imageUrl != widget.imageUrl) {
      _image = AppScope.read(context).api.getLostFoundImage(widget.imageUrl);
    }
  }

  @override
  Widget build(BuildContext context) => SizedBox(
    width: widget.width,
    height: widget.height,
    child: FutureBuilder<Uint8List>(
      future: _image,
      builder: (context, snapshot) {
        if (snapshot.hasData) {
          return Image.memory(
            snapshot.data!,
            fit: BoxFit.cover,
            errorBuilder: (_, _, _) => const Icon(Icons.broken_image_outlined),
          );
        }
        if (snapshot.hasError) {
          return const Tooltip(
            message: 'Image could not be loaded.',
            child: Icon(Icons.broken_image_outlined),
          );
        }
        return const Center(child: CircularProgressIndicator(strokeWidth: 2));
      },
    ),
  );
}

String _dateTime(Map<String, dynamic> report) {
  final date = report['event_date'] ?? '';
  final time = report['event_time'] ?? '';
  return '$date $time'.trim();
}
