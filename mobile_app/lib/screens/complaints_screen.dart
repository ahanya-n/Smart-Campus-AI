import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../models/complaint.dart';
import '../services/api_service.dart';

const _complaintCategories = <String, String>{
  'academic': 'Academic',
  'facilities': 'Facilities',
  'transport': 'Transport',
  'library': 'Library',
  'safety': 'Safety',
  'other': 'Other',
};

class ComplaintsScreen extends StatefulWidget {
  const ComplaintsScreen({super.key});

  @override
  State<ComplaintsScreen> createState() => _ComplaintsScreenState();
}

class _ComplaintsScreenState extends State<ComplaintsScreen> {
  List<CampusComplaint> _complaints = [];
  bool _loading = true;
  bool _submitting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final complaints = await AppScope.read(context).api.getComplaints();
      if (mounted) setState(() => _complaints = complaints);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } on FormatException {
      if (mounted) {
        setState(() => _error = 'Unable to load your complaints right now.');
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _createComplaint() async {
    final draft = await showDialog<_ComplaintDraft>(
      context: context,
      builder: (_) => const _ComplaintFormDialog(),
    );
    if (draft == null || !mounted) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await AppScope.read(context).api.createComplaint(
        category: draft.category,
        title: draft.title,
        description: draft.description,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          const SnackBar(content: Text('Your complaint was submitted.')),
        );
      await _load();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } on FormatException {
      if (mounted) {
        setState(() => _error = 'Unable to submit your complaint right now.');
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Complaints'),
        actions: [
          IconButton(
            tooltip: 'Refresh complaints',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _submitting ? null : _createComplaint,
        icon: const Icon(Icons.add),
        label: Text(_submitting ? 'Submitting…' : 'New complaint'),
      ),
      body: Column(
        children: [
          if (_error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: Material(
                color: Theme.of(context).colorScheme.errorContainer,
                borderRadius: BorderRadius.circular(12),
                child: ListTile(
                  leading: const Icon(Icons.error_outline),
                  title: Text(_error!),
                  trailing: TextButton(
                    onPressed: _loading ? null : _load,
                    child: const Text('Retry'),
                  ),
                ),
              ),
            ),
          Expanded(
            child: _loading && _complaints.isEmpty
                ? const Center(child: CircularProgressIndicator())
                : RefreshIndicator(
                    onRefresh: _load,
                    child: _complaints.isEmpty
                        ? ListView(
                            children: const [
                              SizedBox(height: 100),
                              Icon(Icons.inbox_outlined, size: 48),
                              SizedBox(height: 12),
                              Center(child: Text('You have not submitted any complaints.')),
                            ],
                          )
                        : ListView.separated(
                            padding: const EdgeInsets.fromLTRB(16, 12, 16, 96),
                            itemCount: _complaints.length,
                            separatorBuilder: (_, _) =>
                                const SizedBox(height: 8),
                            itemBuilder: (context, index) =>
                                _ComplaintCard(complaint: _complaints[index]),
                          ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _ComplaintCard extends StatelessWidget {
  const _ComplaintCard({required this.complaint});

  final CampusComplaint complaint;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: ExpansionTile(
        leading: const Icon(Icons.report_problem_outlined),
        title: Text(
          complaint.title,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text(
          '${complaint.categoryLabel} · ${complaint.statusLabel}',
        ),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(complaint.description, style: theme.textTheme.bodyMedium),
          if (complaint.assignedStaffName case final String name)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('Assigned to $name'),
            ),
          if (complaint.resolutionNotes case final String notes)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('Resolution notes: $notes'),
            ),
          const SizedBox(height: 12),
          Text('Responses', style: theme.textTheme.titleSmall),
          if (complaint.responses.isEmpty)
            const Padding(
              padding: EdgeInsets.only(top: 6),
              child: Text('No response has been added yet.'),
            )
          else
            for (final response in complaint.responses)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(response.authorName),
                subtitle: Text([
                  response.message,
                  if (response.resolutionNotes case final String notes)
                    'Resolution: $notes',
                ].join('\n')),
              ),
        ],
      ),
    );
  }
}

class _ComplaintDraft {
  const _ComplaintDraft({
    required this.category,
    required this.title,
    required this.description,
  });

  final String category;
  final String title;
  final String description;
}

class _ComplaintFormDialog extends StatefulWidget {
  const _ComplaintFormDialog();

  @override
  State<_ComplaintFormDialog> createState() => _ComplaintFormDialogState();
}

class _ComplaintFormDialogState extends State<_ComplaintFormDialog> {
  final _formKey = GlobalKey<FormState>();
  final _titleController = TextEditingController();
  final _descriptionController = TextEditingController();
  String _category = 'academic';

  @override
  void dispose() {
    _titleController.dispose();
    _descriptionController.dispose();
    super.dispose();
  }

  String? _validateTitle(String? value) {
    final length = value?.trim().length ?? 0;
    if (length < 3 || length > 120) {
      return 'Enter a title between 3 and 120 characters.';
    }
    return null;
  }

  String? _validateDescription(String? value) {
    final length = value?.trim().length ?? 0;
    if (length < 10 || length > 5000) {
      return 'Enter a description between 10 and 5000 characters.';
    }
    return null;
  }

  void _submit() {
    if (!_formKey.currentState!.validate()) return;
    Navigator.of(context).pop(
      _ComplaintDraft(
        category: _category,
        title: _titleController.text.trim(),
        description: _descriptionController.text.trim(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Submit a complaint'),
      content: Form(
        key: _formKey,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                initialValue: _category,
                decoration: const InputDecoration(labelText: 'Category'),
                items: [
                  for (final entry in _complaintCategories.entries)
                    DropdownMenuItem(
                      value: entry.key,
                      child: Text(entry.value),
                    ),
                ],
                onChanged: (value) {
                  if (value != null) setState(() => _category = value);
                },
              ),
              TextFormField(
                controller: _titleController,
                decoration: const InputDecoration(labelText: 'Title'),
                maxLength: 120,
                validator: _validateTitle,
              ),
              TextFormField(
                controller: _descriptionController,
                decoration: const InputDecoration(labelText: 'Description'),
                maxLength: 5000,
                maxLines: 4,
                validator: _validateDescription,
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _submit,
          child: const Text('Submit'),
        ),
      ],
    );
  }
}
