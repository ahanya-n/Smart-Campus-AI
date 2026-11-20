import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../models/library.dart';
import '../services/api_service.dart';

const _maxActiveLoans = 5;

class LibraryScreen extends StatefulWidget {
  const LibraryScreen({super.key});

  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

class _LibraryScreenState extends State<LibraryScreen> {
  final _searchController = TextEditingController();
  List<LibraryBook> _books = [];
  List<BookLoan> _loans = [];
  bool _loading = true;
  String? _error;
  String? _workingId;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _load({String? search}) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = AppScope.read(context).api;
      final booksFuture = api.getLibraryBooks(
        search: search ?? _searchController.text,
      );
      final loansFuture = api.getLibraryLoans();
      final books = await booksFuture;
      final loans = await loansFuture;
      if (!mounted) return;
      setState(() {
        _books = books;
        _loans = loans;
      });
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } on FormatException {
      if (mounted) {
        setState(() => _error = 'Unable to load the library right now.');
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _perform(
    String id,
    Future<void> Function() action,
    String successMessage,
  ) async {
    setState(() {
      _workingId = id;
      _error = null;
    });
    try {
      await action();
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(successMessage)));
      await _load();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } on FormatException {
      if (mounted) {
        setState(() => _error = 'Unable to complete this library request.');
      }
    } finally {
      if (mounted) setState(() => _workingId = null);
    }
  }

  Future<void> _addBook() async {
    final book = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (_) => const _BookFormDialog(),
    );
    if (book == null || !mounted) return;
    await _perform('create', () async {
      await AppScope.read(context).api.createLibraryBook(
        title: book['title'] as String,
        author: book['author'] as String,
        isbn: book['isbn'] as String,
        category: book['category'] as String,
        totalCopies: book['total_copies'] as int,
      );
    }, 'Book added to the catalog.');
  }

  Future<void> _updateInventory(LibraryBook book) async {
    final totalCopies = await showDialog<int>(
      context: context,
      builder: (_) => _InventoryDialog(currentCopies: book.totalCopies),
    );
    if (totalCopies == null || !mounted) return;
    await _perform('stock-${book.id}', () async {
      await AppScope.read(context).api.updateLibraryBookInventory(
        bookId: book.id,
        totalCopies: totalCopies,
      );
    }, 'Book inventory updated.');
  }

  @override
  Widget build(BuildContext context) {
    final user = AppScope.of(context).auth.user;
    final activeLoans = _loans.where((loan) => loan.isActive).toList();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Library'),
        actions: [
          if (user?.isAdmin == true)
            IconButton(
              tooltip: 'Add book',
              onPressed: _workingId == null ? _addBook : null,
              icon: const Icon(Icons.add),
            ),
          IconButton(
            tooltip: 'Refresh catalog',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: SearchBar(
              controller: _searchController,
              hintText: 'Search title, author, ISBN or category',
              leading: const Icon(Icons.search),
              trailing: [
                if (_searchController.text.isNotEmpty)
                  IconButton(
                    tooltip: 'Clear search',
                    onPressed: () {
                      _searchController.clear();
                      _load(search: '');
                    },
                    icon: const Icon(Icons.clear),
                  ),
              ],
              onSubmitted: (value) => _load(search: value),
              onChanged: (_) => setState(() {}),
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
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
            child: _loading && _books.isEmpty
                ? const Center(child: CircularProgressIndicator())
                : RefreshIndicator(
                    onRefresh: _load,
                    child: ListView(
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                      children: [
                        Text(
                          'Available books',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 8),
                        if (_books.isEmpty && _error == null)
                          const _EmptyLibraryState(
                            message: 'No books match your search.',
                          )
                        else
                          for (final book in _books)
                            _BookCard(
                              book: book,
                              canBorrow:
                                  book.availableCopies > 0 &&
                                  activeLoans.length < _maxActiveLoans,
                              isAdmin: user?.isAdmin == true,
                              working: _workingId != null,
                              workingId: _workingId,
                              onBorrow: () =>
                                  _perform('borrow-${book.id}', () async {
                                    await AppScope.read(context).api
                                        .borrowLibraryBook(book.id);
                                  }, 'Book borrowed. It is due in 14 days.'),
                              onUpdateInventory: () => _updateInventory(book),
                            ),
                        const SizedBox(height: 20),
                        Text(
                          'Borrowing history',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 8),
                        if (_loans.isEmpty && _error == null)
                          const _EmptyLibraryState(
                            message: 'You have no borrowing history yet.',
                          )
                        else if (_loans.isNotEmpty)
                          for (final loan in _loans)
                            _LoanCard(
                              loan: loan,
                              isWorking: _workingId == 'return-${loan.id}',
                              working: _workingId != null,
                              canReturn: loan.isActive,
                              onReturn: () => _perform(
                                'return-${loan.id}',
                                () =>
                                    AppScope.read(context).api
                                        .returnLibraryBook(loan.id),
                                'Book returned.',
                              ),
                            ),
                      ],
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _BookCard extends StatelessWidget {
  const _BookCard({
    required this.book,
    required this.canBorrow,
    required this.isAdmin,
    required this.working,
    required this.workingId,
    required this.onBorrow,
    required this.onUpdateInventory,
  });

  final LibraryBook book;
  final bool canBorrow;
  final bool isAdmin;
  final bool working;
  final String? workingId;
  final VoidCallback onBorrow;
  final VoidCallback onUpdateInventory;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 5),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(book.title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text('${book.author} · ${book.category}'),
            Text('ISBN ${book.isbn}'),
            const SizedBox(height: 8),
            Text(
              '${book.availableCopies} of ${book.totalCopies} copies available',
              style: TextStyle(
                color: book.availableCopies > 0
                    ? colorScheme.primary
                    : colorScheme.error,
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: [
                FilledButton.tonal(
                  onPressed: canBorrow && !working ? onBorrow : null,
                  child: Text(
                    workingId == 'borrow-${book.id}'
                        ? 'Borrowing…'
                        : book.availableCopies == 0
                        ? 'Unavailable'
                        : canBorrow
                        ? 'Borrow'
                        : 'Borrow limit reached',
                  ),
                ),
                if (isAdmin)
                  OutlinedButton(
                    onPressed: working ? null : onUpdateInventory,
                    child: const Text('Update stock'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _LoanCard extends StatelessWidget {
  const _LoanCard({
    required this.loan,
    required this.isWorking,
    required this.working,
    required this.canReturn,
    required this.onReturn,
  });

  final BookLoan loan;
  final bool isWorking;
  final bool working;
  final bool canReturn;
  final VoidCallback onReturn;

  @override
  Widget build(BuildContext context) {
    final due = MaterialLocalizations.of(context).formatShortDate(loan.dueAt);
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 5),
      child: ListTile(
        leading: Icon(
          loan.isActive ? Icons.menu_book_rounded : Icons.assignment_returned,
        ),
        title: Text(loan.bookTitle),
        subtitle: Text(
          loan.isActive
              ? 'Due $due'
              : 'Returned ${loan.returnedAt == null ? due : MaterialLocalizations.of(context).formatShortDate(loan.returnedAt!)}',
        ),
        trailing: canReturn
            ? TextButton(
                onPressed: working ? null : onReturn,
                child: Text(isWorking ? 'Returning…' : 'Return'),
              )
            : null,
      ),
    );
  }
}

class _EmptyLibraryState extends StatelessWidget {
  const _EmptyLibraryState({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(18),
      child: Center(child: Text(message, textAlign: TextAlign.center)),
    ),
  );
}

class _BookFormDialog extends StatefulWidget {
  const _BookFormDialog();

  @override
  State<_BookFormDialog> createState() => _BookFormDialogState();
}

class _BookFormDialogState extends State<_BookFormDialog> {
  final _formKey = GlobalKey<FormState>();
  final _controllers = {
    'title': TextEditingController(),
    'author': TextEditingController(),
    'isbn': TextEditingController(),
    'category': TextEditingController(),
    'total_copies': TextEditingController(text: '1'),
  };

  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Add book'),
    content: Form(
      key: _formKey,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _field('title', 'Title', 160),
            _field('author', 'Author', 120),
            _field('isbn', 'ISBN', 30),
            _field('category', 'Category', 60),
            TextFormField(
              controller: _controllers['total_copies'],
              decoration: const InputDecoration(labelText: 'Total copies'),
              keyboardType: TextInputType.number,
              validator: (value) {
                final copies = int.tryParse(value ?? '');
                return copies == null || copies < 1 || copies > 10000
                    ? 'Enter a whole number from 1 to 10000'
                    : null;
              },
            ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: () {
          if (!_formKey.currentState!.validate()) return;
          Navigator.pop(context, {
            for (final entry in _controllers.entries)
              entry.key: entry.key == 'total_copies'
                  ? int.parse(entry.value.text)
                  : entry.value.text.trim(),
          });
        },
        child: const Text('Add book'),
      ),
    ],
  );

  Widget _field(String name, String label, int maxLength) => TextFormField(
    controller: _controllers[name],
    decoration: InputDecoration(labelText: label),
    maxLength: maxLength,
    validator: (value) =>
        value == null || value.trim().isEmpty ? '$label is required' : null,
  );
}

class _InventoryDialog extends StatefulWidget {
  const _InventoryDialog({required this.currentCopies});

  final int currentCopies;

  @override
  State<_InventoryDialog> createState() => _InventoryDialogState();
}

class _InventoryDialogState extends State<_InventoryDialog> {
  final _formKey = GlobalKey<FormState>();
  late final _controller = TextEditingController(
    text: widget.currentCopies.toString(),
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Update inventory'),
    content: Form(
      key: _formKey,
      child: TextFormField(
        controller: _controller,
        autofocus: true,
        decoration: const InputDecoration(labelText: 'Total copies'),
        keyboardType: TextInputType.number,
        validator: (value) {
          final copies = int.tryParse(value ?? '');
          return copies == null || copies < 1 || copies > 10000
              ? 'Enter a whole number from 1 to 10000'
              : null;
        },
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: () {
          if (!_formKey.currentState!.validate()) return;
          Navigator.pop(context, int.parse(_controller.text));
        },
        child: const Text('Save'),
      ),
    ],
  );
}
